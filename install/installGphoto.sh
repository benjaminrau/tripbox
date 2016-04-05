#!/bin/bash

wget http://www.ibuyopenwrt.com/images/gphoto2_2.5.2-1_ar71xx.ipk
wget http://www.ibuyopenwrt.com/images/libgphoto2-drivers_2.5.2-1_ar71xx.ipk
wget http://www.ibuyopenwrt.com/images/libgphoto2_2.5.2-1_ar71xx.ipk

opkg update
opkg install libgphoto2_2.5.2-1_ar71xx.ipk
opkg install gphoto2_2.5.2-1_ar71xx.ipk
opkg install libgphoto2-drivers_2.5.2-1_ar71xx.ipk

ln -s /usr/lib/libjpeg.so.9 /usr/lib/libjpeg.so.62
ln -s /usr/lib/libreadline.so.6 /usr/lib/libreadline.so.5
