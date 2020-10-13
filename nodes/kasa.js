const isPlainObject = obj => Object.prototype.toString.call(obj) === '[object Object]'

module.exports = function (RED) {
  'use strict'
  const { Client } = require('tplink-smarthome-api')

  function TpLinkNode(config) {
    RED.nodes.createNode(this, config)
    this.config = {
      name: config.name,
      deviceId: config.device,
      interval: parseInt(config.interval),
      eventInterval: parseInt(config.eventInterval),
      payload: config.payload === undefined ? 'getInfo' : config.payload,
      payloadType: config.payloadType === undefined ? 'info' : config.payloadType,
      debug: config.debug
    }

    // Only one client instance used per node
    const client = new Client({
      logLevel: config.debug ? 'debug' : 'warn',
      defaultSendOptions: {
        transport: 'tcp',
        timeout: this.config.eventInterval || 30000
      }
    })
    const moment = require('moment')
    const numeral = require('numeral')
    const context = this.context()

    const node = this
    node.client = client
    // Devices array will hold the device object returned
    // by client.getDevice(). Each device has all methods
    // of the underlying TP-Link API, including an event bus.
    node.devices = new Map()

    // For each new device in this node, a connection is established
    // using the client instance for this node. The returned
    // device object is added to the dictionary of devices, keyed
    // by the shortId (format <IP> or <IP>/<PLUG>). Once added,
    // event proxies are setup, and then polling begins.
    node.connectDevice = async function (id) {
      if (!node.devices.has(id)) {
        // Device shell/placeholder should be setup prior to calling this function
        return
      }

      let shellDevice = node.devices.get(id)
      if (!shellDevice.placeholder) {
        // This shouldn't ever happen - but just in case
        node.error('Attempting to connect to device that already has a connection in this node')
        return shellDevice
      }
      shellDevice.connecting = true

      let [deviceIP, plug] = id.split('/')
      let options = { host: deviceIP }
      if (plug) options.childId = plug

      try {
        let device = await client.getDevice(options)
        await device.getInfo()
        node.setupDevice(id, device)
        return device
      } catch (err) {
        shellDevice.connecting = false
        if (node.config.debug) node.error(`Error connecting to device ${id}: ${err}`)
        // Unable to connect initially. If device is later seen during discovery,
        // it will use the discovery response to 'connect' and everything will
        // then work normally.
        return
      }
    }

    node.setupDevice = function (id, device) {
      device.shortId = id
      device.events = []
      device.online = true

      if (node.config.eventInterval) {
        node.setupEventProxies(device)
        device.startPolling(node.config.eventInterval)
      }

      let queue = node.devices.has(id) && node.devices.get(id).queue
      node.devices.set(id, device)
      if (queue) queue.forEach(msg => node.processInput(msg, device))

      node.updateStatus()

      return device
    }

    // This section uses a single discovery poll to listen to all
    // devices. If the device is tracked in this node, a respective
    // event will be triggered. Note: No message will output if
    // the OnlineEvents have not been started (see below).
    // This is essentially a "isAlive polling" check for all devices.
    // This also catches any devices that failed to connect initially.
    if (node.config.interval)
      client.startDiscovery({
        discoveryInterval: node.config.interval,
        offlineTolerance: 1,
        breakoutChildren: false
      })

    const emitOnlineEvents = state => dev => {
      let host = dev.host
      let ids = [host]
      if (dev.children && !dev.childId)
        dev.children.forEach((x, childId) => ids.push(`${host}/${+childId.slice(-2)}`))

      ids.forEach(id => {
        if (node.devices.has(id)) {
          let device = node.devices.get(id)
          if (device.placeholder && !device.connecting && state == true) {
            // Probably initial connection to device failed. Now
            // that we have the device, set it up, then proceed.
            device = node.setupDevice(id, dev)
          }
          if (!device.placeholder) {
            device.online = state
            device.emit('OnlineEvents', { online: state, state })
          }
        }
      })
      node.updateStatus()
    }
    client.on('device-new', emitOnlineEvents(true))
    client.on('device-online', emitOnlineEvents(true))
    client.on('device-offline', emitOnlineEvents(false))

    client.on('error', error => node.error(`Underlying API error: ${error}`))

    // On input message, determine which device to reference. If a topic
    // is sent, that is used as the deviceId. When topic is omitted, use
    // the node configuration. If the device has not been connected to
    // yet, setup connection first then processing message.
    node.on('input', function (msg) {
      let shortId = msg.topic || node.config.deviceId

      if (!shortId) return

      if (node.devices.has(shortId)) {
        let device = node.devices.get(shortId)
        if (device.placeholder) {
          device.queue.push(msg)
        } else {
          node.processInput(msg, device)
        }
      } else {
        node.devices.set(shortId, {
          placeholder: true,
          queue: [msg]
        })
        node.connectDevice(shortId)
      }
    })

    // Input messages could be one of three categories, based
    // on the type of payload and data within. Once determined,
    // the message is routed onwards.
    // The three categories and their 'next' functions are:
    //   1. Control  >>  (Request made here)  >>  node.sendControlResult()
    //   2. Command  >>  node.handleCommand()
    //   3. Event action  >>  node.handleEventAction()
    node.processInput = function (msg, device) {
      if (node.config.debug)
        node.warn(`Processing input for device ${device.shortId}: ${JSON.stringify(msg)}`)

      let input = msg.payload
      let promises = []

      // OBJECT
      if (isPlainObject(input)) {
        // payload.state
        if (input.hasOwnProperty('state')) {
          if (/^(TOGGLE|SWITCH)$/i.test(input.state)) {
            promises.push(device.togglePowerState())
          } else if (/^(ON|TRUE)$/i.test(input.state)) {
            promises.push(device.setPowerState(true))
          } else if (/^(OFF|FALSE)$/i.test(input.state)) {
            promises.push(device.setPowerState(false))
          } else node.error('Invalid state value; Should be true|on|false|off')
        }

        // payload.brightness
        if (
          input.hasOwnProperty('brightness') &&
          (device.supportsBrightness || device.supportsDimmer) &&
          validateNumber('brightness', input.brightness, 1, 100)
        ) {
          if (device.deviceType == 'bulb') {
            promises.push(device.lighting.setLightState({ brightness: input.brightness }))
          } else {
            promises.push(device.dimmer.setBrightness(input.brightness))
          }
        }

        // payload.temperature
        if (
          input.hasOwnProperty('temperature') &&
          device.supportsColorTemperature &&
          validateNumber('temperature', input.temperature, 2700, 6500)
        ) {
          promises.push(device.lighting.setLightState({ color_temp: input.temperature }))
        }

        // payload.hsb
        if (
          input.hasOwnProperty('hsb') &&
          device.supportsColor &&
          validateNumber('hue', input.hsb.hue, 0, 360) &&
          validateNumber('saturation', input.hsb.saturation, 0, 100) &&
          validateNumber('brightness', input.hsb.brightness, 1, 100)
        ) {
          promises.push(device.lighting.setLightState({ ...input.hsb }))
        }

        // payload.led
        if (input.hasOwnProperty('led') && device.deviceType === 'plug') {
          promises.push(device.setLedState(input.led))
        }

        // payload.events
        if (input.hasOwnProperty('events')) {
          if (typeof input.events === 'array' || input.events instanceof Array) {
            input.events.forEach(event => node.handleEventAction(device, event))
          } else if (typeof input.events === 'string') {
            input.events.split('|').forEach(event => node.handleEventAction(device, event))
          }
        }

        // ARRAY
      } else if (typeof input === 'array' || input instanceof Array) {
        input.forEach(event => node.handleEventAction(device, event))

        // STRING
      } else if (typeof input === 'string' || input instanceof String) {
        let payload = input

        if (/^(TOGGLE|SWITCH)$/i.test(payload)) {
          promises.push(device.togglePowerState())
        } else if (/^(ON|TRUE)$/i.test(payload)) {
          promises.push(device.setPowerState(true))
        } else if (/^(OFF|FALSE)$/i.test(payload)) {
          promises.push(device.setPowerState(false))
        } else if (input.includes('|') || /^(START|STOP)/i.test(payload)) {
          input.split('|').forEach(event => node.handleEventAction(device, event))
        } else {
          node.handleCommand(device, input)
        }

        // BOOLEAN
      } else if (input === true || input === false) {
        promises.push(device.setPowerState(input))

        // UNSUPPORTED
      } else {
        node.error(`Invalid input: ${JSON.stringify(input)}`)
      }

      if (promises.length)
        Promise.all(promises)
          .then(() => node.sendControlResult(device, input))
          .catch(error => {
            if (node.config.debug) node.error(`Error controlling device: ${error}`)
          })
    }

    // Device state was already updated (ie the device was
    // controlled). Here we send an output message based
    // on the node configuration.
    node.sendControlResult = function (device, inputPayload) {
      let msg = {}

      switch (node.config.payloadType) {
        case 'json':
          msg.payload = JSON.parse(inputPayload)
          break
        case 'date':
          msg.payload = Date.now()
          break
        case 'bool':
          msg.payload = inputPayload === 'true'
          break
        case 'num':
          msg.payload = parseInt(inputPayload)
          break
        case 'info':
          node.handleCommand(device, node.config.payload)
          return
      }

      msg.topic = device.shortId
      node.send(msg)
    }

    // Special commands handled here. Also, any input strings that
    // didn't match anything in the processor get sent here and will
    // error by default.
    node.handleCommand = function (device, cmd) {
      let promise
      switch (cmd) {
        case 'getInfo':
          promise = device.getSysInfo()
          break
        case 'getCloudInfo':
          promise = device.cloud.getInfo()
          break
        case 'getQuickInfo':
          promise = device.getInfo()
          break
        case 'getMeterInfo':
          promise = device.emeter.getRealtime()
          break
        case 'getMeterCurrentMonthDayStats':
          promise = device.emeter.getDayStats(new Date().getFullYear(),new Date().getMonth()+1)
          break
        case 'getMeterLastMonthDayStats':
          promise = device.emeter.getDayStats(new Date().getFullYear()-(new Date().getMonth()===1),((new Date().getMonth())-1)%12+1)
          break
        case 'eraseStats':
          promise = device.emeter.eraseStats()
          break
        default:
          return node.error(`Invalid input: ${cmd}`)
      }

      promise
        .then(info =>
          node.send({
            topic: device.shortId,
            payload: {
              ...info,
              timestamp: moment().format()
            }
          })
        )
        .catch(node.error)
    }

    // For each device, an event proxy system is set up that maps the underlying
    // events to the node-based events on the same bus. Only those node-based events
    // that have been turned on (via node.handleEventAction) will end up sending
    // an output on the node.
    node.setupEventProxies = function (device) {
      let powerPrefix = device.deviceType == 'bulb' ? 'lightstate' : 'power'
      device.on(powerPrefix + '-on', () =>
        device.emit('PowerEvents', { powerOn: true, state: true })
      )
      device.on(powerPrefix + '-off', () =>
        device.emit('PowerEvents', { powerOn: false, state: false })
      )
      device.on(powerPrefix + '-update', powerOn => {
        device.emit('PowerUpdateEvents', { powerOn, state: powerOn })
        device.emit('InfoEvents') // placed here to take advantage of polling interval
      })

      device.on('in-use', () => device.emit('InUseEvents', { inUse: true, state: true }))
      device.on('not-in-use', () => device.emit('InUseEvents', { inUse: false, state: false }))
      device.on('in-use-update', inUse => device.emit('InUseUpdateEvents', { inUse, state: inUse }))

      device.on('emeter-realtime-update', emeter => {
        device.emit('MeterEvents', { emeter })
        if (node.devices.size == 1) node.updateStatus()
      })

      device.on('polling-error', error => {
        if (node.config.debug) node.error(`Polling error for ${device.shortId}: ${error}`)
      })
    }

    // Based on the input command, a node-based event is turned on or off as requested.
    node.handleEventAction = function (device, cmd) {
      if (cmd === 'stopAllEvents') return device.removeAllListeners()

      let [match, startStop, event] = cmd.match(/^(start|stop)(.+)/)

      if (!match) return

      if (startStop === 'start' && !device.eventNames().includes(event)) {
        device.on(event, node.makeEventHandler(device, event))
      } else if (startStop === 'stop') {
        device.removeAllListeners(event)
      }
    }

    // When a node-based event is turned on, this generates the callback function
    // that takes the passed properties from the underlying event (based on the
    // parameters in node.setupEventProxies) and outputs a formatted message.
    node.makeEventHandler = function (device, event) {
      if (event == 'InfoEvents')
        return () =>
          node.send({
            topic: device.shortId,
            payload: device.sysInfo
          })

      return passedProps =>
        node.send({
          topic: device.shortId,
          payload: {
            event: event,
            timestamp: moment().format(),
            ...passedProps
          }
        })
    }

    // The node status is different, depending on how many devices
    // are using this node. If only one device is connected then
    // the cached info for that device is used. Any more than one
    // device, and only the number of devices is used. Number of
    // offline device is always shown if more than 0.
    node.updateStatus = function () {
      let onlineDevice
      let numOnline = 0
      let numOffline = 0
      node.devices.forEach(dev => {
        if (dev.online) {
          numOnline++
          onlineDevice = dev
        } else numOffline++
      })

      let status = {
        fill: 'green',
        shape: 'dot'
      }

      if (numOnline === 0) {
        status.fill = 'red'
        status.shape = 'ring'
        status.text = 'No devices connected'
      } else if (numOnline === 1) {
        let device = onlineDevice
        let state = device.relayState ? 'ON' : 'OFF'
        if (device.supportsEmeter) {
          let emeter = device.emeter.realtime
          state += ` [${numeral(emeter.power_mw / 1000.0).format('0.[00]')}W: ${numeral(
            emeter.voltage_mv / 1000.0
          ).format('0.[0]')}V@${numeral(emeter.current_ma / 1000.0).format('0.[000]')}A]`
        }
        status.text = `One device connected (${state})`
      } else {
        status.text = `${numOnline} devices connected`
      }

      if (numOffline > 0) {
        status.fill = 'yellow'
        status.text += ` (${numOffline} offline)`
      }

      node.status(status)
    }

    if (this.config.deviceId) {
      // If configured with a device, initiate connection
      node.devices.set(this.config.deviceId, {
        placeholder: true,
        queue: []
      })
      node.connectDevice(this.config.deviceId)
    } else {
      // Otherwise, initialize status (with no devices)
      node.updateStatus()
    }

    // Helpers
    function validateNumber(propName, value, min, max) {
      if ((value >= min && value <= max) || value === undefined) {
        return true
      } else {
        node.error(`Invalid ${propName} value; Should be between ${min} and ${max}`)
        return false
      }
    }

    // Cleanup when node destroyed
    node.on('close', function () {
      // Important: All code in this function must be sure
      // to not cause any errors. If any error is uncaught,
      // cleanup may not finish properly and there will
      // be a memory leak!
      node.devices.forEach(device => {
        device.stopPolling && device.stopPolling()
        device.closeConnection && device.closeConnection()
      })
      node.client.stopDiscovery()
    })
  }

  //Make available as node
  RED.nodes.registerType('kasa', TpLinkNode)

  RED.httpAdmin.get('/smarthome/devices', (req, res) => {
    try {
      const client = new Client()
      let discoveryTimeout = 10000
      let devices = []
      client.on('device-new', device => {
        devices.push({
          host: device.host,
          alias: device.alias,
          childId: device.childId
        })
      })
      client.startDiscovery()
      setTimeout(() => {
        client.stopDiscovery()
        res.end(JSON.stringify(devices))
      }, discoveryTimeout)
    } catch (error) {
      res.sendStatus(500).send(error.message)
    }
  })
  RED.httpAdmin.get('/smarthome/device', (req, res) => {
    if (!req.query.host) return res.status(500).send('Missing Device IP…')
    const client = new Client()
    client
      .getDevice(req.query)
      .then(device => {
        res.end(
          JSON.stringify({
            model: device.model,
            alias: device.alias
          })
        )
      })
      .catch(error => {
        res.sendStatus(500).send(error.message)
      })
  })
}
