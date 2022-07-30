export const toHex = (num: number): string => {
  const hex = num.toString(16);
  return hex.length % 2 === 1 ? `0${hex}` : hex;
}

export const toMac = (mac0: number, mac1: number): string => {
  const mac = new Array(6);
  mac[0] = (mac1 >> 8) & 0xff;
  mac[1] = mac1 & 0xff;
  mac[2] = (mac0 >> 24) & 0xff;
  mac[3] = (mac0 >> 16) & 0xff;
  mac[4] = (mac0 >> 8) & 0xff;
  mac[5] = mac0 & 0xff;

  return mac.map(toHex).join(':');
}
