#!/usr/bin/env python
"""MCP230XX, python module for the MCP230008 and MCP230017 GPIO
expander chips

created September 9, 2017
last modified October 8, 2017"""

"""
Copyright 2017 Owain Martin

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
"""

import time, sys, smbus

# Register values:
WRITEDAC         = 0x40
WRITEDACEEPROM   = 0x60

# Default I2C address:
DEFAULT_ADDRESS  = 0x62



class MCP4725:

    def __init__(self, i2cAddress=DEFAULT_ADDRESS):

        self.i2cAddress = i2cAddress
        self.bus =smbus.SMBus(1)
        return            

    def set_voltage(self, value):
        """Set the output voltage to specified value.  Value is a 12-bit number
        (0-4095) that is used to calculate the output voltage from:
          Vout =  (VDD*value)/4096
        I.e. the output voltage is the VDD reference scaled by value/4096.
        If persist is true it will save the voltage value in EEPROM so it
        continues after reset (default is false, no persistence).
        """
        # Clamp value to an unsigned 12-bit value.
        if value > 4095:
            value = 4095
        if value < 0:
            value = 0
        # Generate the register bytes and send them.
        # See datasheet figure 6-2:
        #   https://www.adafruit.com/datasheets/mcp4725.pdf 
        reg_data = [(value >> 4) & 0xFF, (value << 4) & 0xFF]
        self.bus.write_i2c_block_data(self.i2cAddress, WRITEDAC, reg_data)


if __name__ == "__main__":

    import RPi.GPIO as IO
    import time, sys

    address = 0x62

        
    MCP = MCP4725(address)

  

    while True:
        MCP.set_voltage(0)
        time.sleep(1)
        MCP.set_voltage(4000) 
        time.sleep(1)


       




    


    

        