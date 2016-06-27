/**
  * Copyright 2016, System Insights, Inc.
  *
  * Licensed under the Apache License, Version 2.0 (the "License");
  * you may not use this file except in compliance with the License.
  * You may obtain a copy of the License at
  *
  *    http://www.apache.org/licenses/LICENSE-2.0
  *
  * Unless required by applicable law or agreed to in writing, software
  * distributed under the License is distributed on an "AS IS" BASIS,
  * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  * See the License for the specific language governing permissions and
  * limitations under the License.
  */

// TODO Base filename should match the name of default export

// Imports - External

const Client = require('node-ssdp').Client; // Control Point
const Loki = require('lokijs');
const util = require('util');
const net = require('net');
const fs = require('fs');
const express = require('express');
const http = require('http');
const R = require('ramda');

// Imports - Internal

const lokijs = require('./lokijs');
const log = require('./config/logger');
const common = require('./common');
const dataStorage = require('./dataStorage');
const jsonToXML = require('./jsonToXML');

// Instances

const agent = new Client();
const Db = new Loki('agent-loki.json');
const devices = Db.addCollection('devices');
const app = express();
const PING_INTERVAL = 10 * 1000; // 10s

let uuid = null;
let insertedData;

// TODO Global list of active sockets

/**
  * findDevice() finds the address, port and UUID from the adapter data
  *
  * @param {Object} headers
  *
  * return uuid
  *
  */
function findDevice(headers) { // TODO: Rename this function
  const headerData = JSON.stringify(headers, null, '  ');
  const data = JSON.parse(headerData);
  const location = data.LOCATION.split(':');
  const found = devices.find({ address: location[0], port: location[1] });
  const uuidfound = data.USN.split(':');
  // TODO Maybe remove old entries and insert the latest
  if (found.length < 1) {
    devices.insert({ address: location[0], port: location[1] });
  }

  return uuidfound[0];
}

/**
  * getHTTP() connect to localhost:8080//sampledevice.xml and
  * get the deviceSchema in XML format.
  *
  * @param = null
  * returns null
  *
  */

function getHTTP() { // TODO: Rename this function
  const options = {
    hostname: 'localhost',
    port: 8080,
    path: '/sampledevice.xml',
  };

  // TODO: Move to a separate function (done)
  // GET ip:8080/VMC-3Axis.xml
  http.get(options, (res) => {
    console.log(`Got response: ${res.statusCode}`);
    res.resume();
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      lokijs.updateSchemaCollection(chunk);
    });
  }).on('error', (e) => {
    console.log(`Got error: ${e.message}`);
  });
}


/* ****************************** Agent ****************************** */

agent.on('response', (headers) => {
  const foundDevice = findDevice(headers);
  uuid = foundDevice;
  getHTTP();
});

agent.on('error', (err) => {
  common.processErrorExit(`${err}`, false);
});

// Search for interested devices
setInterval(() => {
  agent.search('urn:schemas-mtconnect-org:service:VMC-3Axis:1');
}, 3000);

/*
 * TODO For each device in lokijs, create a socket and connect to it.
 * Is it better to maintain global list of active connections?
 */
setInterval(() => {
  const activeDevices = devices.find({});

  log.debug('activeDevices:');
  log.debug(util.inspect(activeDevices));

  activeDevices.forEach((d) => {
    const client = new net.Socket(); // SHOULD client to be changed to Client.

    client.connect(d.port, d.address, () => {
      console.log('Connected.');
    });

    client.on('data', (data) => {
      console.log(`Received:  ${data}`);
      const dataString = String(data).split('\r'); // For Windows
      insertedData = R.pipe(common.inputParsing, lokijs.dataCollectionUpdate);
      insertedData(dataString[0]);
    });

    client.on('error', (err) => { // ECONNREFUSED, remove device
      if (err.errno === 'ECONNREFUSED') {
        const found = devices.find({ address: err.address, port: err.port });

        if (found.length > 0) {
          devices.remove( found );
        }
      }
    });

    client.on('close', () => {
      console.log('Connection closed');
    });
  });
}, PING_INTERVAL);

app.get('/current', (req, res) => {
  console.log("Inside /current");
  const latestSchema = lokijs.searchDeviceSchema(uuid);
  const circularBufferPtr = dataStorage.circularBuffer;
  const dataItemsWithVal = dataStorage.getDataItem(latestSchema, circularBufferPtr);
  const jsonData = jsonToXML.updateJSON(latestSchema, dataItemsWithVal);
  const xmlData = jsonToXML.jsonToXML(JSON.stringify(jsonData), './test/checkfiles/result.xml');
  // TODO:replace reading file with passing object
  const currentXML = fs.readFileSync(xmlData, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/plain',
                            Trailer: 'Content-MD5' });
  res.write(currentXML);
  res.addTrailers({ 'Content-MD5': '7895bf4b8828b55ceaf47747b4bca667' });
  res.end();
});

app.listen(7000, () => {
  console.log('app listening in port 7000');
});
