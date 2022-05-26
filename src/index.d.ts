export interface ProgramFile {
  data: string;
  address: number;
}

export interface ProgramConfig {
  hex?: Buffer;
  files?: ProgramFile[];
  speed?: number;
  tool?: string;
  cpu?: string;
  verbose?: boolean;
}