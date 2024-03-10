import type {
  PortInfo, BindingPortInterface, BindingInterface,
  SetOptions, UpdateOptions,
} from '@serialport/bindings-interface';
import { SerialPortStream, OpenOptions } from '@serialport/stream';
import EventEmitter from 'events';
import { SerialPortPromise } from './serialport-promise';
export interface WebPortInfo extends PortInfo {
  port: SerialPort;
}

export interface WebOpenOptions extends Partial<OpenOptions> {
  port: SerialPort | WebPortInfo;
  baudRate: number;
}

interface WebStreamOpenOptions extends WebOpenOptions {
  binding: typeof WebSerialPortBinding;
  path: string;
  streamer: SerialPortStream;
}

class WebSerialPortBinding extends EventEmitter implements BindingPortInterface {

  static async list(): Promise<WebPortInfo[]> {
    const ports = await navigator.serial.getPorts();
    return ports.map(port => {
      const info = port.getInfo();
      return {
        path: 'not available',
        vendorId: info.usbVendorId?.toString(16).padStart(4, '0'),
        productId: info.usbProductId?.toString(16).padStart(4, '0'),
        port,
      } as WebPortInfo;
    });
  }

  static async open(options: OpenOptions) {
    const opts = options as WebOpenOptions;
    if (!opts.port) throw new Error('Port is required');
    const binding = new WebSerialPortBinding(opts.port as SerialPort | WebPortInfo, opts);
    await binding.#open(opts);
    return binding;
  }

  openOptions: Required<OpenOptions>;
  port: SerialPort;
  isOpen: boolean;
  baudRate: number;
  #opening = false;
  #closing = false;
  #writePromise: Promise<void> | null = null;
  #readPromise: Promise<void> | null = null;
  #readableStream: ReadableStreamDefaultReader | null = null;
  // #closeReader: () => Promise<void> = () => Promise.resolve();

  constructor(port: SerialPort | WebPortInfo, opts: WebOpenOptions) {
    super();
    this.port = port instanceof SerialPort ? port : port.port;
    this.isOpen = false;
    this.baudRate = opts.baudRate || 9600;
    this.openOptions = opts as Required<OpenOptions>;
  }

  async #closeReader() {
    if (!this.#readableStream || !this.port.readable?.locked) return;
    await this.#readableStream.cancel();
    await this.#readableStream.releaseLock();
  }

  #registerReader() {
    if (!this.port?.readable || this.port.readable.locked) return;
    this.#readPromise = new Promise(async (resolve) => {
      if (!this.port?.readable) return;
      this.#readableStream = this.port.readable.getReader();
      let stop = false;
      // this.#closeReader = () => {
      //   stop = true;
      //   return this.#readPromise || Promise.resolve();
      // };
      while (!stop && this.port.readable.locked) {
        const { value, done } = await this.#readableStream.read();
        if (done) {
          stop = true;
        } else if (value) {
          const buffer = Buffer.from(value.buffer);
          // console.log('read hex', buffer.toString('hex'));
          // console.log('read utf8', buffer.toString('utf8'));
          this.emit('data', buffer);
        }
      }
      if (this.port.readable.locked) {
        await this.#readableStream.cancel();
        await this.#readableStream.releaseLock();
      }
      resolve();
    });
  }


  async #open(opts: WebOpenOptions = { port: this.port, baudRate: this.baudRate }) {
    if (this.#opening) return;
    this.#opening = true;
    try {
      const options = { ...this.openOptions, ...opts };
      if (this.isOpen) {
        await this.close();
      }
      if (options.baudRate) {
        this.baudRate = options.baudRate;
      }
      try {
        // console.log(this.baudRate);
        await this.port.open({
          baudRate: this.baudRate,
          // dataBits: options.dataBits,
          // stopBits: options.stopBits,
          // parity: options.parity as ParityType,
          // flowControl: options.rtscts ? 'hardware' : 'none',
          // bufferSize: 1,
        });
      } catch (err: any) {
        if (!err.message.includes('The port is already open')) {
          throw err;
        }
      }

      this.#registerReader();
      this.isOpen = true;
      this.emit('open');
    } finally {
      this.#opening = false;
    }
  }

  async close() {
    if (this.#closing) return;
    if (!this.isOpen) return;
    this.#closing = true;
    try {
      await this.#closeReader();
      // console.log(this.port, this.#readPromise);
      await this.port.close();
      this.isOpen = false;
      this.emit('close');
    } finally {
      this.#closing = false;
    }
  }

  async #write(buffer: Buffer) {
    const writer = this.port.writable?.getWriter();
    if (!writer) throw new Error('Port is not writable');
    await writer.ready;
    // console.log('write hex', buffer.toString('hex'));
    // console.log('write utf8', buffer.toString('utf8'));
    await writer.write(buffer);
    writer.releaseLock();
    // await writer.close();
  }

  write(buffer: Buffer) {
    let promise = null as Promise<void> | null;
    const write = async () => {
      await this.#write(buffer);
      if (promise === this.#writePromise) this.#writePromise = null;
    }
    if (this.#writePromise) {
      promise = this.#writePromise.then(write);
    } else {
      promise = write();
    }
    this.#writePromise = promise;
    return promise;
  }

  read(buffer: Buffer, offset: number, length: number) {
    let dataBuffer = Buffer.alloc(0);
    return new Promise<{ buffer: Buffer, bytesRead: number }>((resolve, reject) => {
      let cleanup = (err?: Error) => {};
      const onData = (data: Buffer) => {
        dataBuffer = Buffer.concat([dataBuffer, data]);
        if (dataBuffer.length >= length) {
          buffer.set(dataBuffer.subarray(0, length), offset);
          cleanup();
        }
      }
      const onClose = () => {
        cleanup(new Error('Port closed before read completed'));
      }
      const onError = (err: Error) => {
        cleanup(err);
      }
      cleanup = (err?: Error) => {
        this.removeListener('data', onData);
        this.removeListener('close', onClose);
        this.removeListener('error', onError);
        if (err) {
          reject(err);
        } else {
          resolve({ buffer, bytesRead: dataBuffer.length });
        }
      }
      this.on('data', onData);
      this.on('close', onClose);
      this.on('error', onError);
    });
  }

  async update(options: UpdateOptions) {
    if (this.baudRate === options.baudRate) return;
    if (options.baudRate) {
      this.baudRate = options.baudRate;
    }
    if (this.isOpen) {
      await this.close();
      await this.#open({ ...options, port: this.port });
    }
  }

  async set(options: SetOptions) {
    // console.log(options, this.port);
    const mappedOpts = {} as SerialOutputSignals;
    if (typeof options.dtr === 'boolean') mappedOpts.dataTerminalReady = options.dtr;
    if (typeof options.rts === 'boolean') mappedOpts.requestToSend = options.rts;
    if (typeof options.brk === 'boolean') mappedOpts.break = options.brk;
    // console.log(mappedOpts);
    await this.port.setSignals(mappedOpts);
  }

  async get() {
    const signals = await this.port.getSignals();
    return {
      cts: signals.clearToSend,
      dsr: signals.dataSetReady,
      dcd: signals.dataCarrierDetect,
    };
  }

  async flush() {
    // pretend to flush
  }

  async drain() {
    // pretend to drain
  }

  async getBaudRate() {
    return { baudRate: this.baudRate };
  }

}

export class WebSerialPort extends SerialPortStream {

  static isSupported() {
    return 'serial' in navigator;
  }

  static async requestPort(reqOpts: SerialPortRequestOptions = {}, openOpts: OpenOptions) {
    const port = await navigator.serial.requestPort(reqOpts);
    return new WebSerialPort(port, openOpts);
  }

  static list() {
    return WebSerialPortBinding.list();
  }

  constructor(port: SerialPort | WebPortInfo, options: Partial<OpenOptions>) {
    super({
      ...options,
      path: 'not available',
      binding: WebSerialPortBinding,
      port,
    } as WebStreamOpenOptions);
    this.once('open', () => {
      const port = this.port as WebSerialPortBinding;
      if (port) port.on('data', (data: Buffer) => {
        this.emit('data', data);
      });
    });
  }
}

export class WebSerialPortPromise extends SerialPortPromise {

  static isSupported() {
    return WebSerialPort.isSupported();
  }

  static async requestPort(reqOpts: SerialPortRequestOptions = {}, openOpts: OpenOptions) {
    const port = await navigator.serial.requestPort(reqOpts);
    return new WebSerialPortPromise(port, openOpts);
  }

  static list() {
    return WebSerialPort.list();
  }

  constructor(port: SerialPort | WebPortInfo, options: Partial<OpenOptions>) {
    const webSerialPort = new WebSerialPort(port, options);
    super(webSerialPort);
  }

}
