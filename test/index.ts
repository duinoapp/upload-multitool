
import { isSupported } from '../src/index';
import { expect } from 'chai';
import 'mocha';

describe('isSupported', () => {
  it('should be true for atmega328p', () => {
    const result = isSupported('avrdude', 'atmega328p');
    expect(result).to.be.true;
  });

  it('should be false for non-existant cpu', () => {
    const result = isSupported('avrdude', 'atmega420');
    expect(result).to.be.false;
  });
  
  it('should be false for non-existant tool', () => {
    const result = isSupported('bob', 'atmega328p');
    expect(result).to.be.false;
  });
});
