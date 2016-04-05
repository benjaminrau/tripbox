var distanceCheckIntervalInSeconds          = 0.5;
var noGpsFallbackPhotoIntervalInSeconds     = 20;
var photoDinstanceInKm                      = 0.2;
var useDisplay                              = false;

var nmeaMessageType                         = "GGA";

var tempDir                        = "/usbstick/tripbox/";
var defaultStorageDir              = "/usbstick/photos/";
var instantPhotoStorageDir         = "/usbstick/photos/instant/";
var mustacheTemplatesDir           = "/usbstick/tripbox/templates/";
var gpsLogFile                     = "/usbstick/tripbox/gpstrack.csv";

var gpsDevice                      = "/dev/ttyUSB0";
var gpsBaud                        = 9600;

var webserverPort                  = 8080;

var takePhotoCommand = {
    executable: "gphoto2",
    arguments: ["--capture-image-and-download", "--force-overwrite"]
};

var readGpsCommand = {
    executable: "python",
    arguments: [tempDir + "readGpsDevice.py", gpsDevice, gpsBaud]
};

var gpio = require('omega_gpio');
var distance = require('distance').distance;
var mv = require('mv');
var nmea = require('nmea');
var trycatch = require('trycatch');
var OLEDExpr = require('onion-oled-js').OLEDExpr;
var http = require('http');
var fs = require('fs');
var url = require('url');
var nmea2decimal = require('nmea2decimal').nmea2decimal;
var mustache = require('mustache');
var parse = require('csv-parse');

var Button = gpio.Button;
var LED = gpio.LED;
var Switch = gpio.Switch;

var takePhotoButton = new Button(26, {when_pressed: "low"});
var showOverallInfoScreenButton = new Button(13, {when_pressed: "low"});
var autoTakePhotoSwitch = new Switch(23, {on_when: "low"});
var myLED = new LED(6);

var hasGps = false;
var takePhotoButtonLastState = false;
var showOverallInfoScreenButtonLastState = false;
var takePhotoInProgress = false;
var lastPhotoTimestamp = 0;
var lastPhotoFileName = lastPhotoFileNameLogged = null;
var lastDistanceCheckTimestamp = 0;

var lastGeolocation = {
    geolocation: {
        latitude: null,
        longitude: null
    }
};

var currentGeolocation = {
    geolocation: {
        latitude: null,
        longitude: null
    }
};

function displayGpsDetails(message) {
    if (false == useDisplay) {
        return;
    }

    OLEDExpr.powerOn()
        .then(OLEDExpr.initialize)
        .then(() => OLEDExpr.write((typeof message != "undefined") ? message : "Last photo:", 7, 0))
        .then(() => (typeof message != "undefined") ? null : OLEDExpr.write(distance.getDistance(currentGeolocation.geolocation, lastGeolocation.geolocation, 2) + "km", 7, 12))
        .then(() => OLEDExpr.write('Last Position:', 0, 0))
        .then(() => OLEDExpr.write('Latitude:', 1, 0))
        .then(() => OLEDExpr.write('Longitude:', 2, 0))
        .then(() => OLEDExpr.write('Current Position:', 3, 0))
        .then(() => OLEDExpr.write('Latitude:', 4, 0))
        .then(() => OLEDExpr.write('Longitude:', 5, 0))
        .then(() => OLEDExpr.write(lastGeolocation.geolocation.latitude, 1, 12))
        .then(() => OLEDExpr.write(lastGeolocation.geolocation.longitude, 2, 12))
        .then(() => OLEDExpr.write(currentGeolocation.geolocation.latitude, 4, 12))
        .then(() => OLEDExpr.write(currentGeolocation.geolocation.longitude, 5, 12));
}

function displayPhotoDetails(fileName, lat, lng) {
    if (false == useDisplay) {
        return;
    }

    OLEDExpr.powerOn()
        .then(OLEDExpr.initialize)
        .then(() => OLEDExpr.write('Filename:', 0, 0))
        .then(() => OLEDExpr.write('Latitude:', 4, 0))
        .then(() => OLEDExpr.write('Longitude:', 5, 0))
        .then(() => OLEDExpr.write(fileName, 1, 0))
        .then(() => OLEDExpr.write(lat, 4, 12))
        .then(() => OLEDExpr.write(lng, 5, 12))
        .then(() => OLEDExpr.write('Captured new photo!', 7, 0));
}

function displayOverallInfoScreen() {
    infoScreenOut = {
        output: ""
    };
    execcmd("sh", ["-c", "df -h | grep usbstick | awk -v OFS='/' '{print $3, $4}'"], function(hddUsage) {
        OLEDExpr.powerOn()
            .then(OLEDExpr.initialize)
            .then(() => OLEDExpr.write("Last JPG:", 6, 0))
            .then(() => OLEDExpr.write(readableDateFromTimestamp(lastPhotoTimestamp).substr(11,8), 6, 10))
            .then(() => OLEDExpr.write(distance.getDistance(currentGeolocation.geolocation, lastGeolocation.geolocation, 2) * 1000 + " m", 7, 10))
            .then(() => OLEDExpr.write('HDD Use:', 1, 0))
            .then(() => OLEDExpr.write('Latitude:', 3, 0))
            .then(() => OLEDExpr.write('Longitude:', 4, 0))
            .then(() => OLEDExpr.write(hddUsage, 1, 10))
            .then(() => OLEDExpr.write(currentGeolocation.geolocation.latitude, 3, 10))
            .then(() => OLEDExpr.write(currentGeolocation.geolocation.longitude, 4, 10));

        setTimeout(function() {
            OLEDExpr
                .clear()
                .then(() => OLEDExpr.powerOff());
        }, 10000);
    }, infoScreenOut);
}

function execcmd(cmd, args, callback, cmdout) {
    var spawn = require('child_process').spawn;
    var child = spawn(cmd, args);

    child.stdout.on('data', function (buffer) { cmdout.output += buffer.toString(); });
    child.stdout.on('end', function() { callback (cmdout.output) });
}

var currentTimestamp = function() {
    return Math.floor(Date.now() / 1000);
}

var readableDateFromTimestamp = function(timestamp) {
    return new Date(timestamp * 1000).toISOString();
}

function watchGps() {
    var spawn = require('child_process').spawn;
    var child = spawn(readGpsCommand.executable, readGpsCommand.arguments);

    child.stdout.on('data', function (buffer) {
        var gprmcStartPosition = buffer.toString().indexOf('$GP' + nmeaMessageType);
        var gprmcEndPosition = buffer.toString().indexOf('\n', gprmcStartPosition);

        if (-1 == gprmcStartPosition) {
            return;
        }

        try {
            var gpsOut = nmea.parse(buffer.toString().substring(gprmcStartPosition, gprmcEndPosition));
            var gpsData = {
                countSat: (typeof gpsOut.numSat != "undefined") ? gpsOut.numSat : null,
                geolocation: nmea2decimal.getDecimal(gpsOut.lat, gpsOut.latPole, gpsOut.lon, gpsOut.lonPole),
                altitude: (typeof gpsOut.alt != "undefined") ? gpsOut.alt : null
            };

            if (gpsData.geolocation.latitude != null && false == isNaN(gpsData.geolocation.latitude)) {
                currentGeolocation = gpsData;
                hasGps = true;
                writeGpsLog();
            } else {
                hasGps = false;
            }
        } catch (error) {
            console.log("Error thrown: " + error);
        }
    });
}

var writeGpsLog = function() {
    var gpsLogRow = [
        currentGeolocation.geolocation.longitude,
        currentGeolocation.geolocation.latitude,
        currentGeolocation.altitude,
        currentTimestamp(),
        lastPhotoFileName != lastPhotoFileNameLogged ? lastPhotoFileName : null
    ].map(function(value){
            return '"' + value + '"';
    }).join(", ");

    gpslogOut = {
        output: ""
    };

    execcmd("sh", ["-c", 'echo "' + gpsLogRow + '" >> ' + gpsLogFile], function(text) {
        lastPhotoFileNameLogged = lastPhotoFileName;
    }, gpslogOut);
}

var takePhoto = function(instant) {
	console.log("Take photo");

    lastGeolocation = currentGeolocation;
	lastPhotoTimestamp = currentTimestamp();
    takePhotoInProgress = true;
	myLED.on();

    takePhotoOut = {
        output: ""
    };

	execcmd(takePhotoCommand.executable, takePhotoCommand.arguments, function(text) {
        takePhotoInProgress = false;

        var textLines = text.split('\n');

        if (typeof textLines[1] != "undefined") {
            var fileName = textLines[1].split(/[ ]+/).pop().replace(/\n/g, "");
        }

        if (typeof fileName != "undefined" && fileName != "problem.") {
            var targetFileNameWithPath = ((typeof instant == "undefined" || instant == false) ? defaultStorageDir : instantPhotoStorageDir) + "TB-" + currentTimestamp() + "-" + currentGeolocation.geolocation.latitude + "-" + currentGeolocation.geolocation.longitude + ".jpg";

            if (-1 != fileName.toLowerCase().indexOf('.jpg')) {
                mv(
                    tempDir + fileName,
                    targetFileNameWithPath,
                    {clobber: true},
                    function (text) {
                        if (typeof instant == "function") {
                            instant(targetFileNameWithPath);
                        }
                    }
                );
                lastPhotoFileName = targetFileNameWithPath;
            }

            displayPhotoDetails(fileName, currentGeolocation.geolocation.latitude, currentGeolocation.geolocation.longitude);
        }

        console.log("Took photo " + fileName);
        myLED.off();
	}, takePhotoOut);
}

var loop = function() {
	if (autoTakePhotoSwitch.isOn() && false == takePhotoInProgress) {
		if (distanceCheckIntervalInSeconds < currentTimestamp() - lastDistanceCheckTimestamp) {
            if (photoDinstanceInKm < distance.getDistance(currentGeolocation.geolocation, lastGeolocation.geolocation, 2) ||
                (false == hasGps && noGpsFallbackPhotoIntervalInSeconds < currentTimestamp() - lastPhotoTimestamp)) {
                takePhoto();
                displayGpsDetails("Capture gps photo.");
            }
            lastDistanceCheckTimestamp = currentTimestamp();
		}
	}

	if(true == takePhotoButton.isPressed() && false == takePhotoInProgress) {
		if (true == takePhotoButtonLastState) {
			setImmediate(loop);
			return;
		}

		takePhotoButtonLastState = true;
        takePhoto(true);
        displayGpsDetails("Capture instant photo.");
	} else {
		takePhotoButtonLastState = false;
	}

    if(true == showOverallInfoScreenButton.isPressed()) {
        if (true == showOverallInfoScreenButtonLastState) {
            setImmediate(loop);
            return;
        }

        showOverallInfoScreenButtonLastState = true;
        displayOverallInfoScreen();
    } else {
        showOverallInfoScreenButtonLastState = false;
    }
  	
	setImmediate(loop);
}

process.on('SIGINT', function() {
    console.log("Cleaning up...");
    takePhotoButton.destroy();
    showOverallInfoScreenButton.destroy();
    myLED.destroy();
    autoTakePhotoSwitch.destroy();
    process.exit();
});

function handleRequest(request, response){
    var request = url.parse(request.url, true);
    var action = request.pathname;
    var contentType = "text/html";
    var responseBody = "";
    var autoEnd = true;

    if (-1 != action.indexOf(defaultStorageDir)) {
        responseBody = fs.readFileSync(action);
        contentType = "image/jpeg";
    } else if (action == '/takePhoto') {
        takePhoto(function (lastPhoto) {
            responseBody = fs.readFileSync(lastPhoto);
            contentType = 'image/jpeg';
        });
    } else if (action == '/lastPhoto.jpg' && null != lastPhotoFileName) {
        responseBody = fs.readFileSync(lastPhotoFileName);
        contentType = "image/jpeg";
    } else if (action == '/map') {
        autoEnd = false;
        var parser = parse({delimiter: ','}, function(err, data){
            var features = [];
            var images = [];
            var coordinates = [];
            var allCoordinates = [];
            data.forEach(function(row, index) {
                if (0 < parseFloat(row[0]) && 0 < parseFloat(row[1])) {
                    if (45 < parseFloat(row[0])) {
                        coordinates.push([parseFloat(row[1]), parseFloat(row[0])]);
                        allCoordinates.push([parseFloat(row[1]), parseFloat(row[0])]);
                    } else {
                        coordinates.push([parseFloat(row[0]), parseFloat(row[1])]);
                        allCoordinates.push([parseFloat(row[0]), parseFloat(row[1])]);
                    }
                }

                if (-1 == row[4].indexOf("null")) {
                    images.push(row[4]);
                }

                if (120 == coordinates.length || (10 == images.length && 0 < coordinates.length) || index == data.length) {
                    features.push({
                        name: "Segment" + index,
                        images: JSON.stringify(images),
                        coordinates: JSON.stringify(coordinates)
                    });
                    coordinates = [];
                    images = [];
                }
            });

            var responseData = {
                lastGeolocation: JSON.stringify(allCoordinates.pop()),
                features: features
            };

            var template = fs.readFileSync(mustacheTemplatesDir + "map.html", "utf8");
            response.end(mustache.to_html(template, responseData));
        });

        fs.createReadStream(gpsLogFile).pipe(parser);
    } else if (action == '/') {
        var responseData = {
            currentGeolocation: currentGeolocation,
            lastGeolocation: lastGeolocation,
            lastPhoto: {
                filename: lastPhotoFileName,
                timestamp: lastPhotoTimestamp,
                distance: distance.getDistance(currentGeolocation.geolocation, lastGeolocation.geolocation, 2) * 1000 + " m"
            }
        };

        var template = fs.readFileSync(mustacheTemplatesDir + "index.html", "utf8");
        responseBody = mustache.to_html(template, responseData);
    }

    response.writeHead(200, {'Content-Type': contentType});

    if (true == autoEnd) {
        if (contentType != "text/html") {
            response.end(responseBody, 'binary');
        }
        response.end(responseBody);
    }
}

var server = http.createServer(handleRequest);
server.listen(webserverPort, function() {
    console.log("Server listening on: http://localhost:%s", webserverPort);
});

watchGps();
setImmediate(loop);
