
import { expect } from 'chai';
import 'mocha';
import { SerialPort } from 'serialport';
import { upload } from '../src/index';
import {
  waitForData, waitForDevice,
  config, getHex,
  espIdentify, ESPIdentifyResult,
} from './util';
import { waitForOpen } from '../src/util/serial-helpers';
import { ProgramFile } from '../src/index.d';

const numEsps = Object.values(config.devices).filter((d) => d.espChip).length;
const listPromise = espIdentify(numEsps);

Object.keys(config.devices).forEach((deviceRef) => {
  const device = config.devices[deviceRef];
  let key = '';
  let hex: Buffer | undefined;
  let files: ProgramFile[] | undefined;
  let serial: SerialPort;
  let flashMode: string | undefined;
  let flashFreq: string | undefined;
  let portList: ESPIdentifyResult[] = [];

  describe(`upload to ${device.name}`, function () {
    this.timeout(120 * 1000);

    before(async () => {
      const res = await getHex(device.code, device.fqbn.trim());
      key = res.key;
      hex = res.hex;
      files = res.files;
      flashMode = res.flashMode;
      flashFreq = res.flashFreq;
      console.log('compiled hex');
    });

    beforeEach(async () => {
      if (serial?.isOpen) await (new Promise(resolve => serial.close(resolve)));
      
      // dynamically find the device path by using VID & PID or esp props
      portList = await listPromise;
      const port = portList.find(p => {
        if (device.vendorIds && device.productIds) {
          return device.vendorIds.includes(p.vendorId || '') && device.productIds.includes(p.productId || '');
        }
        if (device.espChip) {
          return p.esp?.chip === device.espChip;
        }
        if (device.mac) {
          return p.esp?.mac === device.mac;
        }
        return false;
      });
      if (!port) throw new Error(`could not locate ${device.name}`);

      // connect to the device
      serial = new SerialPort({ path: port.path, baudRate: 115200 });
      await waitForOpen(serial);
      console.log(`connected to ${device.name} on ${port.path}`);
    });

    this.afterEach(async () => {
      // make sure connection is closed when we're done
      if (serial?.isOpen) await (new Promise(resolve => serial.close(resolve)));
    });

    it(`should upload to ${device.name}`, async function() {
      this.retries(config.retries || 1);
      await upload(serial, {
        hex,
        files,
        flashMode,
        flashFreq,
        speed: device.speed,
        uploadSpeed: device.uploadSpeed,
        tool: device.tool,
        cpu: device.cpu,
        verbose: config.verbose,
        avr109Reconnect: async () => {
          const port = await waitForDevice(device);
          if (!port) throw new Error(`could not locate ${device.name}`);
          return new SerialPort({ path: port.path, baudRate: 1200 });
        }
      });

      console.log(`uploaded to ${device.name}, validating...`);
      if (device.code === 'ping') {
        await serial.write('ping\n');
      }
      expect(await waitForData(serial, key, 5000)).to.be.true;
    });
  });
});
