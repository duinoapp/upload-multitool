import { SerialPort } from 'serialport/dist/index.d';
import { SerialPortPromise } from '../serialport/serialport-promise';

export const waitForOpen = (serial: SerialPort | SerialPortPromise, timeout: number = 1000): Promise<boolean> => {
  let id = '';
  // id = Math.random().toString(36).substring(7);
  // console.log('waitForOpen', id);
  return new Promise((resolve, reject) => {
    if (serial.isOpen) {
      return resolve(true);
    }
    let resolved = false;
    let timer: NodeJS.Timeout;
    let handleOpen: () => void;
    const cleanup = () => {
      serial.removeListener('open', handleOpen);
      clearTimeout(timer);
    }
    handleOpen = () => {
      if (resolved) return;
      cleanup();
      resolved = true;
      resolve(true);
    };
    timer = setTimeout(() => {
      if (resolved) return;
      cleanup();
      resolved = true;
      if (serial.isOpen) resolve(true);
      else reject(new Error(`Timeout opening port ${id} (${timeout}ms)`));
    }, timeout);
    serial.on('open', handleOpen);
  });
};

export const setBaud = (serial: SerialPort | SerialPortPromise, baud: number): Promise<void> => new Promise((resolve, reject) => {
  if (serial instanceof SerialPortPromise) {
    serial.update({ baudRate: baud }).then(resolve).catch(reject);
    return;
  }
  serial.update({ baudRate: baud }, (err) => {
    if (err) reject(err);
    else resolve();
  });
});

export const setDTRRTS = (serial: SerialPort | SerialPortPromise, flag: boolean): Promise<void> => new Promise((resolve, reject) => {
  if (serial instanceof SerialPortPromise) {
    serial.set({ dtr: flag, rts: flag }).then(resolve).catch(reject);
    return;
  }
  serial.set({ dtr: flag, rts: flag }, (err) => {
    if (err) reject(err);
    else resolve();
  });
});
