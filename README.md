# upload-multitool

**WIP:** This project is currently a work in progress

A modern tool for uploading to micro controllers like Arduinos and ESP devices, written in typescript with automated tests.

## Project Objectives

This project aims to achieve the following:
- Production ready
  - Written in TypeScript
  - Automated testing against real devices
- Browser friendly
  - SerialPort Agnostic (connection is passed through)
  - Small bundle size?
- Developer Friendly
  - Promises
  - Linting
  - Documentation
  - Modern development practices
- Board Variety
  - Support most arduino protocols
  - Support ESP devices
  - Platform for easy addition of new protocols

## Usage

install your favourite way
```bash
npm install @duinoapp/upload-multitool
yarn add @duinoapp/upload-multitool
pnpm add @duinoapp/upload-multitool
```

This package exports a few utilities, the main one is upload

```js
import { upload } from '@duinoapp/upload-multitool';
import type { ProgramConfig } from '@duinoapp/upload-multitool';
import { SerialPort } from 'serialport';

const serialport = new SerialPort({ path: '/dev/example', baudRate: 115200 });

const config = {
  // for avr boards, the compiled hex
  bin: compiled.hex,
  // for esp boards, the compiled files and flash settings
  files: compiled.files,
  flashFreq: compiled.flashFreq,
  flashMode: compiled.flashMode,
  // baud rate to connect to bootloader
  speed: 115200,
  // baud rate to use for upload (ESP)
  uploadSpeed: 115200,
  // the tool to use, avrdude or esptool
  tool: 'avr',
  // the CPU of the device
  cpu: 'atmega328p',
  // a standard out interface ({ write(msg: string): void })
  stdout: process.stdout,
  // whether or not to log to stdout verbosely
  verbose: true,
  // handle reconnecting to AVR109 devices when connecting to the bootloader
  // the device ID changes for the bootloader, meaning in some OS's a new connection is required
  // avr109Reconnect?: (opts: ReconnectParams) => Promise<SerialPort>;
} as ProgramConfig;

const res = await upload(serial.port, config);

```

If you want to programmatically check if a tool/cpu is supported:

```js
import { isSupported } from '@duinoapp/upload-multitool';

console.log(isSupported('avr', 'atmega328p')); // true
```

Also exports some helpful utilities:

```js
import { WebSerialPort, SerialPortPromise, WebSerialPortPromise } from '@duinoapp/upload-multitool';

// WebSerialPort is a drop-in web replacement for serialport, with some useful static methods:

// Check whether the current browser supports the Web Serial API
// https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API#browser_compatibility
WebSerialPort.isSupported() // true/false

// request a serial connection from the user,
// first param takes requestPort options: https://developer.mozilla.org/en-US/docs/Web/API/Serial/requestPort#parameters
// second params takes the default open options 
const serialport = WebSerialPort.requestPort({}, { baudRate: 115200 });
serialport.open((err) => {
  if (!err) serialport.write('hello', (err2) => ...)
});

// get a list of the serial connections that have already been requested:
const list = WebSerialPort.list();

// A wrapper util around SerialPort that exposes the same methods but with promises
const serial = new SerialPortPromise(await WebSerialPort.requestPort());
await serial.open();
await serial.write('hello');

// A Merged class of both WebSerialPort and SerialPortPromise, probably use this one
const serial = WebSerialPortPromise.requestPort();
await serial.open();
await serial.write('hello');
```

### Upload return
The upload function will return an object:
```ts
{
  // the time it took to complete the upload
  time: number
  // the final serial port used. In most cases the serial port passes in
  // if you pass in a non promise port, internally it will wrap with SerialPortPromise
  // if you pass in a promise port, it is likely the same object, you can check with the serialport.key value on SerialPortPromise
  // if using AVR109 and a reconnect is needed, this will likely be a new connection.
  serialport: SerialPortPromise | WebSerialPortPromise
}
```


## Get in touch 
You can contact me in the #multitool-general channel of the duinoapp discord

[![Join Discord](https://i.imgur.com/Gk2od5o.png)](https://discord.gg/FKQp7N4)

## Influences
This project aims to be a full recode based on existing projects before it:
- [avrgirl-arduino](https://github.com/noopkat/avrgirl-arduino)
- [stk500v1](https://github.com/jacobrosenthal/js-stk500v1)
- [stk500v2](https://github.com/Pinoccio/js-stk500)
- [chip.avr.avr109](https://github.com/tmpvar/chip.avr.avr109)
- [esptool-js](https://github.com/espressif/esptool-js)