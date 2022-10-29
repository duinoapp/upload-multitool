
import { isSupported } from '../src/index';
import { expect } from 'chai';
import 'mocha';

describe('isSupported', () => {
  it('should be true for atmega328p', () => {
    const result = isSupported('avrdude', 'atmega328p');
    expect(result).to.be.true;
  });

  it('should be true for esp8266', () => {
    const result = isSupported('esptool', 'esp8266');
    expect(result).to.be.true;
  });

  it('should be false for non-existant cpu (atmega420)', () => {
    const result = isSupported('avrdude', 'atmega420');
    expect(result).to.be.false;
  });

  it('should be false for non-existant cpu (esp69)', () => {
    const result = isSupported('esptool', 'esp69');
    expect(result).to.be.false;
  });
  
  it('should be false for non-existant tool', () => {
    const result = isSupported('bob', 'atmega328p');
    expect(result).to.be.false;
  });
});
