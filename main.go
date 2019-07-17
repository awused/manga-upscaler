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

type Config struct {
	Port                    int
	CacheLimit              int
	TempDirectory           string
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
}

var conf Config
var cache map[string]string
var ready map[string]chan struct{}
var current []string
var mapLock sync.Mutex
var gpuLock sync.Mutex
var listener net.Listener
var tempDir string
var closed = make(chan struct{})
var jobsChan = make(chan *upscaleJob)

var closedError = errors.New("Closed")

func main() {
	flag.Parse()
	if err := awconf.LoadConfig("manga-upscaler", &conf); err != nil {
		log.Panic(err)
	}

	temp, err := ioutil.TempDir(conf.TempDirectory, "manga-upscaler")
	if err != nil {
		log.Panic(err)
	}
	tempDir = temp
	defer cleanup()

	cache = make(map[string]string)
	ready = make(map[string]chan struct{})
	current = []string{}

	serverChan := make(chan error)
	go runServer(serverChan)

	upscalerChan := make(chan struct{})
	go runUpscaler(upscalerChan)

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGUSR1, syscall.SIGTERM)

Loop:
	for {
		select {
		case err = <-serverChan:
			if err != nil {
				log.Fatalf("webserver.Run() exited unexpectedly with [%v]", err)
			}
			log.Fatalf("webserver.Run() exited unexpectedly")
		case sig := <-sigs:
			switch sig {
			case syscall.SIGTERM:
				close(closed)
				break Loop
			case syscall.SIGINT:
				close(closed)
				break Loop
			case syscall.SIGUSR1:
				log.Info("SIGUSR1")
			}
		}
	}
	signal.Reset(syscall.SIGINT, syscall.SIGTERM)

	log.Info("SIGINT/SIGTERM caught, exiting")
	listener.Close()
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

	listener, err = net.Listen("tcp", "localhost:"+strconv.Itoa(conf.Port))
	if err != nil {
		log.Error(err)
		serverChan <- err
		return
	}

	err = http.Serve(listener, getRouter())
	select {
	case <-closed:
	default:
		log.Error(err)
		serverChan <- err
	}
}

func getRouter() http.Handler {
	router := chi.NewRouter()
	router.Use(middleware.RealIP)
	router.Use(middleware.Logger)
	router.Use(middleware.Recoverer)

	router.Get("/*", serveImage)

	return router
}

func cacheImage(key string) (string, error) {
	imageURLBytes, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		return "", err
	}
	imageURL := string(imageURLBytes)

	extension := filepath.Ext(imageURL)

	mapLock.Lock()
	inFile := filepath.Join(tempDir, key) + extension
	// These may be the same
	outFile := filepath.Join(tempDir, key) + ".png"
	readyChan := make(chan struct{})
	cache[key] = outFile
	ready[key] = readyChan
	mapLock.Unlock()
	defer close(readyChan)

	maybeDeleteImage()

	err = downloadImage(imageURL, inFile)
	if err != nil {
		os.Remove(inFile)
		os.Remove(outFile)
		mapLock.Lock()
		delete(cache, key)
		delete(ready, key)
		mapLock.Unlock()
		return "", err
	}

	job := upscaleJob{
		inFile:   inFile,
		outFile:  outFile,
		url:      imageURL,
		doneChan: make(chan error),
	}

	select {
	case jobsChan <- &job:
	case <-closed:
		os.Remove(inFile)
		os.Remove(outFile)
		mapLock.Lock()
		delete(cache, key)
		delete(ready, key)
		mapLock.Unlock()
		return "", closedError
	}

	select {
	case err = <-job.doneChan:
		if err != nil {
			os.Remove(inFile)
			os.Remove(outFile)
			mapLock.Lock()
			delete(cache, key)
			delete(ready, key)
			mapLock.Unlock()
			return "", err
		}
	case <-closed:
		os.Remove(inFile)
		os.Remove(outFile)
		mapLock.Lock()
		delete(cache, key)
		delete(ready, key)
		mapLock.Unlock()
		return "", closedError
	}
	// TODO -- make this conditional?
	// err = upscaleImage(inFile, outFile)
	// if err != nil {
	// 	os.Remove(inFile)
	// 	os.Remove(outFile)
	// 	mapLock.Lock()
	// 	delete(cache, key)
	// 	delete(ready, key)
	// 	mapLock.Unlock()
	// 	return "", err
	// }

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
	defer resp.Body.Close()
	if err != nil {
		return err
	}

	_, err = io.Copy(f, resp.Body)
	if err != nil {
		return err
	}
	return nil
}

func maybeDeleteImage() {
	mapLock.Lock()
	defer mapLock.Unlock()

	if len(current) < conf.CacheLimit {
		return
	}

	log.Error("deleting")
	key := current[0]
	current = current[1:]

	readyChan := ready[key]
	<-readyChan
	file := cache[key]

	delete(cache, key)
	delete(ready, key)

	os.Remove(file)
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

		sort.Slice(pendingJobs, func(i, j int) bool {
			return !natsort.Compare(pendingJobs[i].url, pendingJobs[j].url)
		})

		// Take the highest priority job and execute it
		job := pendingJobs[len(pendingJobs)-1]
		pendingJobs = pendingJobs[:len(pendingJobs)-1]

		job.doneChan <- upscaleImage(job.inFile, job.outFile)
		close(job.doneChan)
	}

	for _, v := range pendingJobs {
		v.doneChan <- closedError
		close(v.doneChan)
	}
}

func serveImage(w http.ResponseWriter, r *http.Request) {
	imageKey := r.URL.Path[1:]

	mapLock.Lock()
	ch, ok := ready[imageKey]
	file := cache[imageKey]
	mapLock.Unlock()

	if !ok {
		var err error
		file, err = cacheImage(imageKey)
		if err == closedError {
			return
		} else if err != nil {
			log.Panic(err)
		}
	} else {
		<-ch
		// The file may no longer exist but either way we're serving an error
	}

	w.Header().Set("Cache-Control", "max-age=2592000") // 30 days
	http.ServeFile(w, r, file)
}
