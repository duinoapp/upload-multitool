import { SerialPort } from 'serialport/dist/index.d';

export const waitForOpen = (serial: SerialPort, timeout: number = 1000): Promise<boolean> => {
  let id = '';
  // id = Math.random().toString(36).substring(7);
  // console.log('waitForOpen', id);
  return new Promise((resolve, reject) => {
    if (serial.isOpen) {
      return resolve(true);
    }
    let cleanup = () => {};
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout opening port ${id} (${timeout}ms)`));
    }, timeout);
    const handleOpen = () => {
      cleanup();
      resolve(true);
    };
    serial.on('open', handleOpen);
    cleanup = () => {
      serial.removeListener('open', handleOpen);
      clearTimeout(timer);
    }
  });
};

export const setBaud = (serial: SerialPort, baud: number): Promise<void> => new Promise((resolve, reject) => {
  serial.update({ baudRate: baud }, (err) => {
    if (err) reject(err);
    else resolve();
  });
});

export const setDTRRTS = (serial: SerialPort, flag: boolean): Promise<void> => new Promise((resolve, reject) => {
  serial.set({ dtr: flag, rts: flag }, (err) => {
    if (err) reject(err);
    else resolve();
  });
});
