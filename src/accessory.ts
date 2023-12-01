import { AccessoryPlugin, API, Logger } from 'homebridge';
import storage from 'node-persist';
import GPIO from 'rpi-gpio';
import { AccessoryConfig } from 'homebridge/lib/bridgeService';
import axios from 'axios';
import { promisify } from 'util';

const readPromise = promisify(GPIO.read);

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class GpioDoorbellAccessory implements AccessoryPlugin {
  private storage;

  private informationService;
  private doorbellService;
  private activationService;
  private muteCharacteristic;
  private activationCharacteristic;

  private lastRang?: number;

  private readonly doorbellMuteKey = 'homebridge-gpio-doorbell.mute';
  private doorbellMute: boolean;
  private readonly doorbellActiveKey = 'homebridge-gpio-doorbell.active';
  private doorbellActive: boolean;
  private lastPinChangeDate = Date.now(); // timestamp in ms
  private lastPinChangeValue = true; // We start with true (circuit open)
  private lastProcessedDate = Date.now(); // timestamp in ms
  private lastProcessedValue = false;
  private timeout: NodeJS.Timeout | undefined = undefined;

  constructor(
    public readonly log: Logger,
    public readonly config: AccessoryConfig,
    public readonly api: API,
  ) {
    this.log.debug('Homebridge GPIO Doorbell loaded.');

    // init storage
    const cacheDir = this.api.user.persistPath();
    this.storage = storage.create();
    this.storage.initSync({ dir: cacheDir, forgiveParseErrors: true });

    // add accessory information
    this.informationService = new this.api.hap.Service.AccessoryInformation()
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Homebridge')
      .setCharacteristic(this.api.hap.Characteristic.Model, 'GPIO Doorbell');

    // create new doorbell accessory
    this.doorbellService = new this.api.hap.Service.Doorbell(this.config.name);

    // add characteristic ProgrammableSwitchEvent
    this.doorbellService.getCharacteristic(
      this.api.hap.Characteristic.ProgrammableSwitchEvent,
    );

    // setup mute characteristic
    if (this.config.enableOutput) {
      this.muteCharacteristic = this.doorbellService.getCharacteristic(
        this.api.hap.Characteristic.Mute,
      );
      this.muteCharacteristic.onGet(this.handleMuteGet.bind(this));
      this.muteCharacteristic.onSet(this.handleMuteSet.bind(this));
    }

    // setup activation characteristic
    this.activationService = new this.api.hap.Service.Switch(this.config.name);
    this.activationCharacteristic = this.activationService.getCharacteristic(
      this.api.hap.Characteristic.On,
    );
    this.activationCharacteristic.onGet(this.handleActivationGet.bind(this));
    this.activationCharacteristic.onSet(this.handleActivationSet.bind(this));


    // restore persisted settings for mute
    this.doorbellMute = this.storage.getItemSync(this.doorbellMuteKey) || false;
    this.storage.setItemSync(this.doorbellMuteKey, this.doorbellMute);
    this.doorbellService.updateCharacteristic(
      this.api.hap.Characteristic.Mute,
      this.doorbellMute as boolean,
    );

    // restore persisted settings for activation
    this.doorbellActive = this.storage.getItemSync(this.doorbellActiveKey) || false;
    this.storage.setItemSync(this.doorbellActiveKey, this.doorbellActive);
    this.activationService.updateCharacteristic(
      this.api.hap.Characteristic.On,
      this.doorbellActive as boolean,
    );

    // setup gpio
    this.setupGpio();
  }

  getServices() {
    return [this.informationService, this.doorbellService, this.activationService];
  }

  read(channel: number): boolean | undefined {
    let value: boolean | undefined;
    readPromise(channel)
      .then(val => {
        value = val;
      })
      .catch(err => {
        this.log.error(err);
        value = undefined;
      });
    return value;
  }

  setupGpio(): void {
    GPIO.on('change', (channel, value) => this.handlePinChange(channel, value));
    GPIO.setup(this.config.gpioPin, GPIO.DIR_IN, GPIO.EDGE_BOTH);

    if (this.config.enableOutput) {
      this.log.debug(`Enable output on pin ${this.config.outputGpioPin}`);

      GPIO.setup(this.config.outputGpioPin, GPIO.DIR_LOW);
    }
  }

  /**
   * @param gpioPin
   * @param circuitOpen true when circuit is open, false if circuit is closed
   * @private
   */
  private async handlePinChange(
    gpioPin: number,
    circuitOpen: boolean,
  ): Promise<void> {
    // We get the date of the last pin change
    this.lastPinChangeDate = Date.now();
    this.log.debug(
      `Pin ${gpioPin}: ${this.lastPinChangeValue} -> ${circuitOpen}.` +
        ` processChange(${this.lastPinChangeDate}) in 100ms`,
    );
    this.lastPinChangeValue = circuitOpen;

    // To prevent glitches, we make delayed call with a change identifier (based on timestamp)
    // If a change has been observed before scheduled call has been invoked, it will do nothing, and a new
    // call will be scheduled.
    if (this.timeout !== undefined) {
      //this.log.debug('Cancelling TO');
    }
    this.timeout = setTimeout(
      (gpioPin, changeTimeStamp) => {
        this.log.debug(`Process Pin Change -- ${changeTimeStamp}.`);

        // Is it the last change?
        if (this.lastPinChangeDate !== changeTimeStamp) {
          // Ignore if it is not the change identifier: there has been other pin changes in the while.
          this.log.debug(
            `IGNORE because ${changeTimeStamp} is not the last change processing request ${this.lastPinChangeDate}.`,
          );
          return;
        }

        // Is it an actual change?
        if (this.lastProcessedValue === this.lastPinChangeValue) {
          this.log.debug(
            `IGNORE because pin change ${this.lastPinChangeValue} is the same as last processed value ${this.lastProcessedValue}.`,
          );
          return;
        }

        this.log.debug(`ACCEPT with value ${this.lastPinChangeValue}.`);
        this.lastProcessedValue = this.lastPinChangeValue;
        this.lastProcessedDate = changeTimeStamp;

        let buttonPushed = !this.lastPinChangeValue;

        if (this.config.negateInput) {
          buttonPushed = !buttonPushed;
        }

        // handle GPIO output
        if (this.config.enableOutput && !this.doorbellMute && this.doorbellActive) {
          this.log.debug(
            `Setting GPIO pin ${this.config.outputGpioPin} to ${
              buttonPushed ? 'HIGH' : 'LOW'
            }`,
          );

          GPIO.write(this.config.outputGpioPin, buttonPushed);
        }

        this.log.debug(`Button Pushed? ${buttonPushed}.`);
        if (buttonPushed) {
          // handle throttle time
          const now = Date.now();
          if (
            this.lastRang &&
            this.lastRang + this.config.throttleTime >= now
          ) {
            this.log.debug(
              `IGNORE state change on pin ${gpioPin} because throttle time has not expired.`,
            );
            return;
          } else {
            this.lastRang = Date.now();
          }

          this.log.info(`Doorbell "${this.config.name}" rang.`);

          if (!this.doorbellActive) {
            this.log.info('But it is not active.');
          } else {
            // Forward ring.
            // In homekit
            this.log.info('Forwarding ring directly to HomeKit.');
            this.doorbellService.updateCharacteristic(
              this.api.hap.Characteristic.ProgrammableSwitchEvent,
              this.api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
            );
            // Via 3rd party plugin as well
            if (this.config.enableHttpTrigger && this.config.httpTriggerUrl) {
              const url = this.config.httpTriggerUrl;
              this.log.info(`Performing request to webhook at ${url}.`);
              try {
                axios.get(url);
                /* eslint-disable  @typescript-eslint/no-explicit-any */
              } catch (e: any) {
                if (e.response) {
                  this.log.error(
                    `Request to webhook failed with status code ${e.response.status}: ${e.response.data}`,
                  );
                } else {
                  this.log.error(
                    `Request to webhook failed with message: ${e?.message}`,
                  );
                }
              }
            }
          }
        }
      },
      this.config.glitchTime,
      gpioPin,
      this.lastPinChangeDate,
    );
  }

  private handleMuteSet(value: boolean): void {
    this.log.debug(`Set mute to ${value}.`);

    this.doorbellMute = value;
    this.storage.setItemSync(this.doorbellMuteKey, this.doorbellMute);

    if (!this.doorbellMute && this.config.enableOutput) {
      GPIO.write(this.config.outputGpioPin, false);
    }
  }

  private handleMuteGet(): boolean {
    this.log.debug('Get mute.');
    return this.doorbellMute;
  }

  private handleActivationSet(value: boolean): void {
    this.log.debug(`Set activated to ${value}.`);

    this.doorbellActive = value;
    this.storage.setItemSync(this.doorbellActiveKey, this.doorbellActive);
  }

  private handleActivationGet(): boolean {
    this.log.debug('Get activated.');
    return this.doorbellActive;
  }
}
