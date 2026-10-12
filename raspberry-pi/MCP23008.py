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


class MCP23008:

    def __init__(self, i2cAddress):

        self.i2cAddress = i2cAddress
        self.bus =smbus.SMBus(1)
        return            

    def single_access_read(self, reg=0x00):
        """single_access_read, function to read a single data register
        of the MCP230xx gpio expander"""                  
       
        dataTransfer=self.bus.read_byte_data(self.i2cAddress,reg)
        
        return dataTransfer

    def single_access_write(self, reg=0x00, regValue=0x0):
        """single_access_write, function to write to a single data register
        of the MCP230xx gpio expander"""
        
        self.bus.write_byte_data(self.i2cAddress, reg, regValue)

        return

    def register_bit_select(self, pin, reg8A, reg8B):
        """register_bit_select,  function to return the proper
        register and bit position to use for a particular GPIO
        and GPIO function"""
      
        if pin >= 0 and pin < 8:            
            bit = pin
            reg = reg8A
        elif pin >= 8 and pin <16:
            bit = pin - 8
            reg = reg8B        

        return reg, bit


    def set_register_addressing(self, regScheme='8bit'):
        """set_register_addressing, function to change how the registers
        are mapped.  For an MCP23008, bank should always equal '8bit'.  This
        sets bit 7 of the IOCON register"""        

        reg = 0x05
        regValue = self.single_access_read(reg)
        regValue = regValue & 0b01111111
        regValue = regValue | (1<<7)
        self.single_access_write(reg, regValue)        

        return

    def set_mode(self, pin, mode, pullUp='disable'):
        """set_mode, function to set up a GPIO pin to either an input
        or output. The input pullup resistor can also be enabled.
        This sets the appropriate bits in the IODIRA/B and GPPUA/B
        registers"""

        # GPIO direction set up section

        reg, bit = self.register_bit_select(pin ,reg8A=0x00, reg8B=0x10)
                
        regValue = self.single_access_read(reg)
        
        if mode == 'output':
            mask = 0b11111111 & ~(1<<bit)            
            regValue = regValue & mask                
            self.single_access_write(reg, regValue)           

        else: # mode = input
            mask = 0x00 | (1<<bit)           
            regValue = regValue | mask                
            self.single_access_write(reg, regValue)            

        # pullUp enable/disable section

        if mode == 'input':
            reg, bit = self.register_bit_select(pin ,reg8A=0x06, reg8B=0x16)

            regValue = self.single_access_read(reg)

            if pullUp == 'enable':
                mask = 0x00 | (1<<bit)           
                regValue = regValue | mask                
                self.single_access_write(reg, regValue)
            else: # pullUp = disable
                mask = 0b11111111 & ~(1<<bit)            
                regValue = regValue & mask                
                self.single_access_write(reg, regValue)            

        return

    def invert_input(self, pin, invert = False):
        """invert_input, function to invert the output of the pins
        corresponding GPIO register bit.  Sets bit in IPOLA/B"""

        # input invert on/off section

        reg, bit = self.register_bit_select(pin ,reg8A=0x01,reg8B=0x11)

        regValue = self.single_access_read(reg)

        if invert == True:
            mask = 0x00 | (1<<bit)           
            regValue = regValue | mask                
            self.single_access_write(reg, regValue)
        else: # invert = False
            mask = 0b11111111 & ~(1<<bit)            
            regValue = regValue & mask                
            self.single_access_write(reg, regValue)        

        return

    def output(self, pin, value):
        """output, function to set the state of a GPIO output
        pin via the appropriate bit in the OLATA/B registers"""    

        reg, bit = self.register_bit_select(pin ,reg8A=0x0A,reg8B=0X1A)
                
        regValue = self.single_access_read(reg)

        if value == 1:
            # set output high        
            mask = 0x00 | (1<<bit)           
            regValue = regValue | mask        
        else:
            # set output low
            mask = 0b11111111 & ~(1<<bit)            
            regValue = regValue & mask

        self.single_access_write(reg, regValue)              

        return

    def input(self, pin):
        """input, function to get the current level of a GPIO input
        pin by reading the appropriate bit in the GPIOA/B registers"""    

        reg, bit = self.register_bit_select(pin ,reg8A=0x09, reg8B=0X19)
                
        regValue = self.single_access_read(reg)

        mask = 0x00 | (1<<bit)
        value = regValue & mask
        value = value >> bit              

        return value

    
    
    def register_reset(self):
        """register_reset, function to put chip back to default
        settings"""

        #print('resetting')

        self.single_access_write(0x00, 0xFF)
        for i in range(1, 12):
            self.single_access_write(i, 0x00)

        return

    def __del__(self):
        """__del__, function to clean up expander object and put chip
        back to default settings"""

        #print('deleting')

        self.register_reset()

        return

if __name__ == "__main__":

    import RPi.GPIO as IO
    import time, sys

    address = 0x20

    # set up GPIO settings
    IO.setwarnings(False)
    IO.setmode(IO.BCM)
        
    MCP = MCP23008(address)

    # output tests

    MCP.set_mode(0, 'output')
    MCP.output(0, 1)
    time.sleep(3)
    MCP.output(0, 0)   

    while True:
        MCP.output(0, 1)
        time.sleep(1)
        MCP.output(0, 0) 
        time.sleep(1)

    # input tests    
    
    MCP.set_mode(2, 'input', 'enable') # was pin 2
    #MCP.invert_input(2, True)
    for i in range(0,10):
        print(MCP.input(2))
        time.sleep(0.5)
    #MCP.invert_input(2, False)


    try:
        while True:
            time.sleep(0.25)

    except:
        IO.cleanup()

    finally:        
        MCP.__del__()        




    


    

        