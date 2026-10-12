import cv2 as cv
from imutils.video.pivideostream import PiVideoStream
import imutils
import time
import threading
from datetime import datetime
import numpy as np

class VideoCamera(object):
    def __init__(self, flip = False, file_type  = ".jpg", photo_string= "stream_photo"):
        self.flip = flip # Flip frame vertically
        self.file_type = file_type # image type i.e. .jpg
        self.photo_string = photo_string # Name to save the photo

        self.vs = None
        self.viewers = 0
        self.encoding = False
        self.encode_thread = None
        self.stop_timer = None
        self.STOP_GRACE_SECONDS = 3  # margem antes de desligar a câmara ao ficar sem viewers

        self.lock = threading.Lock()          # protege viewers/vs/encode_thread/stop_timer
        self.frame_condition = threading.Condition()
        self.latest_jpeg = None

    def __del__(self):
        if self.vs is not None:
            self.vs.stop()

    def flip_if_needed(self, frame):
        if self.flip:
            return np.flip(frame, 0)
        return frame

    # ---------- gestão de viewers (arranque/paragem lazy da câmara) ----------

    def add_viewer(self):
        with self.lock:
            self.viewers += 1
            if self.stop_timer is not None:
                self.stop_timer.cancel()
                self.stop_timer = None
            if self.viewers == 1:
                self._start_camera()

    def remove_viewer(self):
        with self.lock:
            self.viewers = max(0, self.viewers - 1)
            if self.viewers == 0:
                self.stop_timer = threading.Timer(self.STOP_GRACE_SECONDS, self._check_stop)
                self.stop_timer.daemon = True
                self.stop_timer.start()

    def _check_stop(self):
        with self.lock:
            self.stop_timer = None
            if self.viewers == 0:
                self._stop_camera()

    def _start_camera(self):
        # já chamado com self.lock preso
        if self.vs is None:
            self.vs = PiVideoStream().start()
            time.sleep(2.0)  # dar tempo à câmara para "aquecer"
        if not self.encoding:
            self.encoding = True
            self.encode_thread = threading.Thread(target=self._encode_loop, daemon=True)
            self.encode_thread.start()

    def _stop_camera(self):
        # já chamado com self.lock preso
        self.encoding = False
        if self.vs is not None:
            self.vs.stop()
            self.vs = None
        with self.frame_condition:
            self.latest_jpeg = None

    # ---------- encode único, partilhado por todos os viewers ----------

    def _encode_loop(self):
        target_interval = 1 / 15  # 15 fps
        while self.encoding:
            vs = self.vs
            if vs is None:
                break
            try:
                frame = self.flip_if_needed(vs.read())
                if frame is None:
                    time.sleep(target_interval)
                    continue
                ret, jpeg = cv.imencode(self.file_type, frame)
                if not ret:
                    time.sleep(target_interval)
                    continue
            except Exception as e:
                print("Erro no encode da câmara:", e)
                time.sleep(target_interval)
                continue

            with self.frame_condition:
                if not self.encoding:
                    break
                self.latest_jpeg = jpeg.tobytes()
                self.frame_condition.notify_all()

            time.sleep(target_interval)



    def get_shared_frame(self, timeout=2.0):
        """Usado pelo gen() do main.py: espera pelo próximo frame já codificado."""
        with self.frame_condition:
            self.frame_condition.wait(timeout=timeout)
            return self.latest_jpeg

    # ---------- tirar foto (botão da câmara) ----------

    def take_picture(self):
        self.add_viewer()
        try:
            frame = self.flip_if_needed(self.vs.read())
            ret, image = cv.imencode(self.file_type, frame)
            today_date = datetime.now().strftime("%m%d%Y-%H%M%S") # get current time
            cv.imwrite(str(self.photo_string + "_" + today_date + self.file_type), frame)
        finally:
            self.remove_viewer()
