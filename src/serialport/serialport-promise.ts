import type { SerialPort } from 'serialport';
import type { SetOptions } from '@serialport/bindings-interface'
import type { WebSerialPort } from './web-serialport';
import EventEmitter from 'events';

// a class that wraps a serial port and provides a promise-based interface

export class SerialPortPromise extends EventEmitter {
  port: SerialPort | WebSerialPort;
  _key: string;
  isSerialPortPromise = true;
  
  /**
   * Consumes a serial port and returns a similar promise-based interface
   * @emits open
   * @emits data
   * @emits close
   * @emits error
   */
  constructor(port: SerialPort | WebSerialPort) {
    super();
    this._key = Math.random().toString(36).substring(2);
    this.port = port;
    this.port.on('open', () => this.emit('open'));
    this.port.on('close', () => this.emit('close'));
    this.port.on('error', (err) => this.emit('error', err));
    this.port.on('data', (data) => this.emit('data', data));
  }

  get key(): string {
    return this._key;
  }

  get isOpen(): boolean {
    return this.port.isOpen;
  }

  get path(): string {
    return this.port.path;
  }

  get baudRate(): number {
    return this.port.baudRate;
  }

  /**
   * Opens a connection to the given serial port.
   * @emits open
   */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.open((err) => {
        if (err) {
          if (err.message.includes('Port is opening')) {
            this.port.once('open', resolve);
          }
          else reject(err);
        }
        else resolve();
      });
    });
  }

  /**
   * Closes an open connection.
   *
   * If there are in progress writes when the port is closed the writes will error.
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Returns the number of bytes that have been read in the internal buffer.
   * @param {number} [size] Optional number of bytes to return from the read buffer.
   * @returns {Buffer|null} The data from the read buffer. null is returned when no data is available.
   */
  async read(size?: number): Promise<Buffer|null> {
    return this.port.read(size);
  }


  /**
   * Writes data to the given serial port. Buffers written data if the port is not open.

  The write operation is non-blocking. When it returns, data might still not have been written to the serial port. See `drain()`.

  Some devices, like the Arduino, reset when you open a connection to them. In such cases, immediately writing to the device will cause lost data as they wont be ready to receive the data. This is often worked around by having the Arduino send a "ready" byte that your Node program waits for before writing. You can also often get away with waiting around 400ms.

  If a port is disconnected during a write, the write will error in addition to the `close` event.

  From the [stream docs](https://nodejs.org/api/stream.html#stream_writable_write_chunk_encoding_callback) write errors don't always provide the error in the callback, sometimes they use the error event.
  > If an error occurs, the callback may or may not be called with the error as its first argument. To reliably detect write errors, add a listener for the 'error' event.

  In addition to the usual `stream.write` arguments (`String` and `Buffer`), `write()` can accept arrays of bytes (positive numbers under 256) which is passed to `Buffer.from([])` for conversion. This extra functionality is pretty sweet.

  * @param  {(string|array|buffer)} data Accepts a [`Buffer`](http://nodejs.org/api/buffer.html) object, or a type that is accepted by the `Buffer.from` method (e.g. an array of bytes or a string).
   * @param  {string=} encoding The encoding, if chunk is a string. Defaults to `'utf8'`. Also accepts `'ascii'`, `'base64'`, `'binary'`, and `'hex'` See [Buffers and Character Encodings](https://nodejs.org/api/buffer.html#buffer_buffers_and_character_encodings) for all available options.
   */
  write(data: string | Array<number> | Buffer, encoding?: BufferEncoding): Promise<void> {
    return new Promise((resolve, reject) => {
      let needsDrain = false;
      const finish = (err: Error | null, isDrain?: boolean) => {
        if (err) reject(err);
        else if (!needsDrain || isDrain) resolve();
      };
      if (encoding) {
        needsDrain = !this.port.write(data, encoding, (err) => {
          if (err) reject(err);
          else finish(null, false);
        });
      } else {
        needsDrain = !this.port.write(data, (err) => {
          if (err) reject(err);
          else finish(null, false);
        });
      }
      if (needsDrain) {
        this.port.once('drain', () => finish(null, true));
      }
    });
  }

  drain(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.drain((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  flush(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.flush((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Changes the baud rate for an open port. Emits an error or calls the callback if the baud rate isn't supported.
   * @param {object=} options Only supports `baudRate`.
   * @param {number=} [options.baudRate] The baud rate of the port to be opened. This should match one of the commonly available baud rates, such as 110, 300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, or 115200. Custom rates are supported best effort per platform. The device connected to the serial port is not guaranteed to support the requested baud rate, even if the port itself supports that baud rate.
   * @returns {undefined}
   */
  update(options: { baudRate: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.update(options, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Set control flags on an open port. Uses [`SetCommMask`](https://msdn.microsoft.com/en-us/library/windows/desktop/aa363257(v=vs.85).aspx)
   * for Windows and [`ioctl`](http://linux.die.net/man/4/tty_ioctl) for OS X and Linux.
   *
   * All options are operating system default when the port is opened. Every flag is set on each call to the provided or default values. If options isn't provided default options is used.
   * @param {object=} options
   * @param {boolean=} [options.brk=false] sets the brk flag
   * @param {boolean=} [options.cts=false] sets the cts flag
   * @param {boolean=} [options.dsr=false] sets the dsr flag
   * @param {boolean=} [options.dtr=true] sets the dtr flag
   * @param {boolean=} [options.rts=true] sets the rts flag
   */
  set(options: SetOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.set(options, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }


  /**
   * Returns the control flags (CTS, DSR, DCD) on the open port.
   * Uses [`GetCommModemStatus`](https://msdn.microsoft.com/en-us/library/windows/desktop/aa363258(v=vs.85).aspx)
   * for Windows and [`ioctl`](http://linux.die.net/man/4/tty_ioctl) for mac and linux.
   * @returns {object}
   */
  get(): Promise<{ cts: boolean; dsr: boolean; dcd: boolean }> {
    return new Promise((resolve, reject) => {
      this.port.get((err, options) => {
        if (err) reject(err);
        else if (!options) reject(new Error('No options returned'));
        else resolve(options);
      });
    });
  }

  /**
   * The readable.pause() method will cause a stream in flowing mode to stop emitting 'data' events, switching out of flowing mode.
   * Any data that becomes available will remain in the internal buffer.
   * @returns {SerialPort} returns `this`
   */
  pause(): SerialPortPromise {
    this.port.pause();
    return this;
  }

  /**
   * The readable.resume() method causes an explicitly paused, Readable stream to resume emitting 'data' events,
   * switching the stream into flowing mode.
   * @returns {SerialPort} returns `this`
   */
  resume(): SerialPortPromise {
    this.port.resume();
    return this;
  }

}

