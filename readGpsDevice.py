import sys, serial

connected = False
port = sys.argv[1]
baud = sys.argv[2]

serial = serial.Serial(port, baud, timeout=1)

while not connected:
    connected = True

    while True:
       print serial.readline().rstrip()
       sys.stdout.flush()
