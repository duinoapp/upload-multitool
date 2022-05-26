# upload-multitool

**WIP:** This project is currently a work in progress

A modern tool for uploading to micro controllers like Arduinos and ESP devices, written in typescript with automated tests.

## Project Objectives

This project aims to achieve the following:
- Production ready
  - Written in TypeScript
  - Automated testing against real devices
- Browser friendly
  - SerialPort Agnostic (connection is passed through)
  - Small bundle size?
- Developer Friendly
  - Promises
  - Linting
  - Documentation
  - Modern development practices
- Board Variety
  - Support most arduino protocols
  - Support ESP devices
  - Platform for easy addition of new protocols

## Get in touch 
You can contact me in the #multitool-general channel of the duinoapp discord

[![Join Discord](https://i.imgur.com/Gk2od5o.png)](https://discord.gg/FKQp7N4)

## Influences
This project aims to be a full recode based on existing projects before it:
- [avrgirl-arduino](https://github.com/noopkat/avrgirl-arduino)
- [stk500v1](https://github.com/jacobrosenthal/js-stk500v1)
- [stk500v2](https://github.com/Pinoccio/js-stk500)
- [chip.avr.avr109](https://github.com/tmpvar/chip.avr.avr109)
- [esptool-js](https://github.com/espressif/esptool-js)