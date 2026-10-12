import cv2
from threading import Thread
import time
import numpy as np

class WebcamVideoStream:
    def __init__(self, src = 0):
        print("init")
        self.stream = cv2.VideoCapture(src)
        (self.grabbed, self.frame) = self.stream.read()
        self.stopped = False
        time.sleep(2.0)
    
    def start(self):
        print("start thread")
        t = Thread(target=self.update, args=())
        t.daemon = True