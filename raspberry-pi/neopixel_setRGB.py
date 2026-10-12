# Simple test for NeoPixels on Raspberry Pi
import time
import board
import neopixel
import sys

#def   read_data (arg1, arg2, arg3)

# Choose an open pin connected to the Data In of the NeoPixel strip, i.e. board.D18
# NeoPixels must be connected to D10, D12, D18 or D21 to work.
pixel_pin = board.D18

# The number of NeoPixels
num_pixels = 12

# The order of the pixel colors - RGB or GRB. Some NeoPixels have red and green reversed!
# For RGBW NeoPixels, simply change the ORDER to RGBW or GRBW.
ORDER = neopixel.GRB

pixels = neopixel.NeoPixel(
pixel_pin, num_pixels, brightness=0.3, auto_write=False, pixel_order=ORDER)


#while true:
    #print ("Parameter sum: " + sys.argv[0])
pixels.fill((int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])))
#pixels.fill((255,255,255))
pixels.show()
exit()
    
    
