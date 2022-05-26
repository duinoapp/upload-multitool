
import { expect } from 'chai';
import 'mocha';
import { SerialPort } from 'serialport';
import { upload } from '../../src/index';
import { waitForData, config, getHex } from '../util';
import { waitForOpen } from '../../src/util/serial-helpers';

let key = '';
let hex: Buffer;
let serial: SerialPort;

describe('upload to uno', function () {
  this.timeout(120 * 1000);

  before(async () => {
    const res = await getHex('blink', 'arduino:avr:uno');
    key = res.key;
    hex = res.hex;
    console.log('compiled hex');
  });

  beforeEach(async () => {
    if (serial?.isOpen) await (new Promise(resolve => serial.close(resolve)));
    serial = new SerialPort({ path: config.devices.uno, baudRate: 115200 });
    await waitForOpen(serial);
    console.log('connected to uno');
  });

  this.afterEach(async () => {
    if (serial?.isOpen) await (new Promise(resolve => serial.close(resolve)));
  });

  it('should upload to uno', async () => {
    await upload(serial, {
      hex,
      speed: 115200,
      tool: 'avrdude',
      cpu: 'atmega328p',
    });
    console.log('uploaded to uno, validating...');
    expect(await waitForData(serial, key, 3000)).to.be.true;
  });
});
