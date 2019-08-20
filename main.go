package main

import (
	"encoding/base64"
	"errors"
	"flag"
	"io"
	"io/ioutil"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/awused/awconf"
	"github.com/facette/natsort"
	"github.com/go-chi/chi"
	"github.com/go-chi/chi/middleware"
	log "github.com/sirupsen/logrus"
)

type config struct {
	Port                    int
	CacheLimit              int
	TempDirectory           string
	MaxAgeMinutes           int
	LogFile                 string
	Waifu2xNCNNVulkan       string
	ForceOpenCL             bool
	Waifu2xNCNNVulkanModels string
	Cloudscraper            bool
}

type upscaleJob struct {
	doneChan chan error
	url      string
	inFile   string
	outFile  string
	// Chapter and page are used to prioritize jobs
	chapter string
	page    string
}

type cachedImage struct {
	file      string
	ready     chan struct{}
	timestamp time.Time
}

var conf config
var cache map[string]*cachedImage
var cachedQueue []string
var mapLock sync.Mutex
var gpuLock sync.Mutex
var listener net.Listener
var tempDir string
var closed = make(chan struct{})
var jobsChan = make(chan *upscaleJob)

var errClosed = errors.New("Closed")

func main() {
	flag.Parse()
	if err := awconf.LoadConfig("manga-upscaler", &conf); err != nil {
		log.Panic(err)
	}

	log.SetOutput(os.Stdout)
	log.SetFormatter(&log.TextFormatter{
		ForceColors:   true,
		FullTimestamp: true,
	})

	if conf.CacheLimit < 1 {
		conf.CacheLimit = 1
	}
	if conf.MaxAgeMinutes < 10 {
		conf.MaxAgeMinutes = 10
	}

	temp, err := ioutil.TempDir(conf.TempDirectory, "manga-upscaler")
	if err != nil {
		log.Panic(err)
	}
	tempDir = temp
	defer cleanup()

	cache = make(map[string]*cachedImage)
	cachedQueue = []string{}

	listener, err = net.Listen("tcp", "localhost:"+strconv.Itoa(conf.Port))
	if err != nil {
		log.Panic(err)
	}

	serverChan := make(chan error)
	go runServer(serverChan)

	upscalerChan := make(chan struct{})
	go runUpscaler(upscalerChan)

	expirationChan := make(chan struct{})
	go runExpirer(expirationChan)

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)

Loop:
	for {
		select {
		case err = <-serverChan:
			if err != nil {
				log.Panicf("webserver.Run() exited unexpectedly with [%v]", err)
			}
			log.Panicf("webserver.Run() exited unexpectedly")
		case sig := <-sigs:
			switch sig {
			case syscall.SIGTERM:
				close(closed)
				break Loop
			case syscall.SIGINT:
				close(closed)
				break Loop
			}
		}
	}
	signal.Reset(syscall.SIGINT, syscall.SIGTERM)

	log.Info("SIGINT/SIGTERM caught, exiting")
	listener.Close()
	<-expirationChan
	<-upscalerChan
	<-serverChan
}

func cleanup() {
	if tempDir != "" {
		os.RemoveAll(tempDir)
	}
}

func runServer(serverChan chan<- error) {
	defer close(serverChan)
	var err error

	err = http.Serve(listener, getRouter())
	select {
	case <-closed:
	default:
		log.Error(err)
		serverChan <- err
	}
}

func getRouter() http.Handler {
	middleware.DefaultLogger = middleware.RequestLogger(
		&middleware.DefaultLogFormatter{
			Logger:  log.StandardLogger(),
			NoColor: false,
		})

	router := chi.NewRouter()
	router.Use(middleware.RealIP)
	router.Use(middleware.Logger)
	router.Use(middleware.Recoverer)

	router.Get("/*", serveImage)

	return router
}

func cacheImage(key string, chapter string, page string) (string, error) {
	imageURLBytes, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		return "", err
	}
	imageURL := string(imageURLBytes)

	extension := filepath.Ext(imageURL)
	inFile := filepath.Join(tempDir, key) + extension
	// These may be the same
	outFile := filepath.Join(tempDir, key) + ".png"

	mapLock.Lock()
	existingImage, ok := cache[key]
	if ok {
		mapLock.Unlock()
		<-existingImage.ready
		return existingImage.file, nil
	}

	readyChan := make(chan struct{})
	cache[key] = &cachedImage{
		file:      outFile,
		ready:     readyChan,
		timestamp: time.Now(),
	}
	cachedQueue = append(cachedQueue, key)
	mapLock.Unlock()
	defer close(readyChan)

	maybeDeleteImage()

	err = downloadImage(imageURL, inFile)
	if err != nil {
		os.Remove(inFile)
		os.Remove(outFile)
		mapLock.Lock()
		delete(cache, key)
		mapLock.Unlock()
		return "", err
	}

	job := upscaleJob{
		inFile:   inFile,
		outFile:  outFile,
		url:      imageURL,
		doneChan: make(chan error, 1),
		chapter:  chapter,
		page:     page,
	}

	select {
	case jobsChan <- &job:
	case <-closed:
		os.Remove(inFile)
		os.Remove(outFile)
		mapLock.Lock()
		delete(cache, key)
		mapLock.Unlock()
		return "", errClosed
	}

	select {
	case err = <-job.doneChan:
		if err != nil {
			os.Remove(inFile)
			os.Remove(outFile)
			mapLock.Lock()
			delete(cache, key)
			mapLock.Unlock()
			return "", err
		}
	case <-closed:
		os.Remove(inFile)
		os.Remove(outFile)
		mapLock.Lock()
		delete(cache, key)
		mapLock.Unlock()
		return "", errClosed
	}

	if inFile != outFile {
		os.Remove(inFile)
	}

	log.Info("Finished caching " + imageURL)
	return outFile, nil
}

func downloadImage(url string, file string) error {
	f, err := os.Create(file)
	if err != nil {
		return err
	}
	defer f.Close()

	// TODO -- cloudscraper
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	_, err = io.Copy(f, resp.Body)
	if err != nil {
		return err
	}
	return nil
}

func maybeDeleteImage() {
	mapLock.Lock()
	defer mapLock.Unlock()

	if len(cachedQueue) <= conf.CacheLimit {
		return
	}

	deleteOldestImage()
}

// Requires mapLock to be held
func deleteOldestImage() {
	key := cachedQueue[0]
	cachedQueue = cachedQueue[1:]

	cached := cache[key]
	<-cached.ready
	delete(cache, key)

	os.Remove(cached.file)
}

func upscaleImage(inFile, outFile string) error {
	args := []string{
		"-i", inFile,
		"-o", outFile,
		// "--png-compression", "0", // Gotta go fast
		"-m", conf.Waifu2xNCNNVulkanModels,
		"-s", "2",
		"-n", "1",
	}

	gpuLock.Lock()
	defer gpuLock.Unlock()
	out, err := exec.Command(conf.Waifu2xNCNNVulkan, args...).CombinedOutput()
	if err != nil {
		log.Error(string(out))
	}
	return err
}

// Do all jobs in a single thread and prioritize them based on lexicographical
// order
func runUpscaler(doneChan chan<- struct{}) {
	defer close(doneChan)

	pendingJobs := []*upscaleJob{}

UpscaleLoop:
	for true {
		if len(pendingJobs) == 0 {
			select {
			case <-closed:
				break UpscaleLoop
			case job := <-jobsChan:
				pendingJobs = append(pendingJobs, job)
			}

			// A short delay to attempt to let other requests arrive.
			// This tries to serve the first image as early as possible on initial
			// load.
			<-time.After(100 * time.Millisecond)
		} else {
			select {
			case <-closed:
				break UpscaleLoop
			default:
			}
		}

	PendingLoop:
		for true {
			select {
			case job := <-jobsChan:
				pendingJobs = append(pendingJobs, job)
			default:
				break PendingLoop
			}
		}

		// Sort in reverse order
		sort.Slice(pendingJobs, func(i, j int) bool {
			a := pendingJobs[i]
			b := pendingJobs[j]
			if a.chapter != b.chapter {
				// Natsort is unnecessary here but it should handle even weird
				// edge cases well
				return natsort.Compare(b.chapter, a.chapter)
			}
			if a.page != b.page {
				return natsort.Compare(b.page, a.page)
			}
			// Fall back to natural sorting based on the URL
			return natsort.Compare(b.url, a.url)
		})

		// Take the highest priority job and execute it
		job := pendingJobs[len(pendingJobs)-1]
		pendingJobs = pendingJobs[:len(pendingJobs)-1]

		job.doneChan <- upscaleImage(job.inFile, job.outFile)
		close(job.doneChan)
	}

	for _, v := range pendingJobs {
		v.doneChan <- errClosed
		close(v.doneChan)
	}
}

func serveImage(w http.ResponseWriter, r *http.Request) {
	imageKey := r.URL.Path[1:]
	chapter := r.URL.Query().Get("chapter")
	page := r.URL.Query().Get("page")

	mapLock.Lock()
	cached, ok := cache[imageKey]
	mapLock.Unlock()

	file := ""

	if !ok {
		var err error
		file, err = cacheImage(imageKey, chapter, page)
		if err == errClosed {
			return
		} else if err != nil {
			log.Panic(err)
		}
	} else {
		file = cached.file
		<-cached.ready
		// The file may no longer exist but either way we're serving an error
	}

	w.Header().Set("Cache-Control", "max-age=2592000") // 30 days
	http.ServeFile(w, r, file)
}

func runExpirer(doneChan chan<- struct{}) {
	defer close(doneChan)

	maxMinutes := time.Duration(conf.MaxAgeMinutes) * time.Minute

ExpireLoop:
	for true {
		expiredTime := time.Now().Add(-1 * maxMinutes)
		nextWakeTime := time.Now().Add(maxMinutes)

		mapLock.Lock()
		for len(cachedQueue) > 0 {
			cached := cache[cachedQueue[0]]
			if cached.timestamp.After(expiredTime) {
				nextWakeTime = cached.timestamp.Add(maxMinutes)
				break
			}

			deleteOldestImage()
		}
		mapLock.Unlock()

		select {
		case <-time.After(time.Until(nextWakeTime)):
		case <-closed:
			break ExpireLoop
		}
	}
}
