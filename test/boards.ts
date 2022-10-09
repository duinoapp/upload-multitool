
import { expect } from 'chai';
import 'mocha';
import { SerialPort } from 'serialport';
import { upload } from '../src/index';
import { waitForData, config, getHex } from './util';
import { waitForOpen } from '../src/util/serial-helpers';
import { ProgramFile } from '../src/index.d';

Object.keys(config.devices).forEach((deviceRef) => {
  const device = config.devices[deviceRef];
  let key = '';
  let hex: Buffer | undefined;
  let files: ProgramFile[] | undefined;
  let serial: SerialPort;

  describe(`upload to ${device.name}`, function () {
    this.timeout(120 * 1000);

    before(async () => {
      const res = await getHex(device.code, device.fqbn);
      key = res.key;
      hex = res.hex;
      files = res.files;
      console.log('compiled hex');
    });

    beforeEach(async () => {
      if (serial?.isOpen) await (new Promise(resolve => serial.close(resolve)));
      
      // dynamically find the device path by using VID & PID
      const list = await SerialPort.list();
      const port = list.find(p => device.vendorIds.includes(p.vendorId) && device.productIds.includes(p.productId));
      if (!port) throw new Error(`could not locate ${device.name}`);

      // connect to the device
      serial = new SerialPort({ path: port.path, baudRate: device.speed });
      await waitForOpen(serial);
      console.log(`connected to ${device.name}`);
    });

    this.afterEach(async () => {
      // make sure connection is closed when we're done
      if (serial?.isOpen) await (new Promise(resolve => serial.close(resolve)));
    });

    it(`should upload to ${device.name}`, async () => {
      await upload(serial, {
        hex,
        files,
        speed: device.speed,
        tool: device.tool,
        cpu: device.cpu,
        verbose: config.verbose,
      });
      console.log(`uploaded to ${device.name}, validating...`);
      expect(await waitForData(serial, key, 3000)).to.be.true;
    });
  });
});
