export interface ProgramFile {
  data: string;
  address: number;
}

export interface ProgramConfig {
  hex?: Buffer;
  files?: ProgramFile[];
  speed?: number;
  uploadSpeed?: number;
  tool?: string;
  cpu?: string;
  verbose?: boolean;
  flashMode?: string;
  flashFreq?: string;
  avr109Reconnect?: () => Promise<SerialPort>;
}