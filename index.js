#!/usr/bin/env node

var archiver = require('hypercore-archiver')
var swarm = require('hypercore-archiver/swarm')
var irc = require('irc')
var mkdirp = require('mkdirp')
var minimist = require('minimist')
var pump = require('pump')
var prettyBytes = require('pretty-bytes')
var prettyTime = require('pretty-time')
var extend = require('xtend')

var argv = minimist(process.argv.slice(2), {
  alias: {
    channel: 'c',
    cwd: 'd',
    server: 's',
    name: 'n',
    ircPort: 'irc-port'
    // port: 'p',
    // announce: 'a'
  },
  default: {
    // port: 3282, TODO: add to hyeprcore-archiver/swarm.js
    cwd: 'hypercore-archiver',
    name: 'archive-bot',
    server: 'irc.freenode.net'
    // announce: false TODO: Not applicable anymore?
  }
})

mkdirp.sync(argv.cwd)

var started = process.hrtime()
var ar = archiver(argv.cwd)
var server = swarm(ar)
var client = null
var pending = {}

ar.on('sync', archiveSync)
ar.on('changes', function () {
  console.log('Changes feed available at', ar.changes.key.toString('hex'))
})
ar.on('remove', function (feed) {
  console.log('Removing', feed.key.toString('hex'))
})
ar.on('add', function (feed) {
  console.log('Adding', feed.key.toString('hex'))
})

if (argv.channel) {
  var ircOpts = extend({}, argv, {
    channels: [argv.channel],
    retryCount: 1000,
    autoRejoin: true
  })
  ircOpts.port = argv.ircPort

  console.log('Connecting to IRC', argv.server, 'as', argv.name)
  client = new irc.Client(argv.server, argv.name, ircOpts)

  client.on('registered', function (msg) {
    console.log('Connected to IRC, listening for messages')
  })

  client.on('message', function (from, to, message) {
    var op = parse(message)
    if (!op) return
    var channel = (to === argv.name) ? from : argv.channel
    var key = op.key
    switch (op.command) {
      case 'track':
        sendMessage('TODO: Not supported?')
        // ar.add(new Buffer(key, 'hex'), {content: false}, function (err) {
        //   if (err) return sendMessage(err, channel)
        //   sendMessage(null, channel, 'Tracking ' + key)
        // })
        return
      case 'add':
        pending[key] = {channel: channel}
        ar.add(new Buffer(key, 'hex'), function (err) {
          if (err) return sendMessage(err, channel)
          sendMessage(null, channel, 'Adding ' + key)
        })
        return
      case 'rm':
      case 'remove':
        if (pending[key]) delete pending[key]
        ar.remove(new Buffer(key, 'hex'), function (err) {
          if (err) return sendMessage(err, channel)
          sendMessage(null, channel, 'Removing ' + key)
        })
        return
      case 'status':
        if (key) {
          return statusKey(key, function (err, status) {
            if (err) return sendMessage(err, channel)
            var need = status.need
            var have = status.have
            var progress = (have / need) * 100
            sendMessage(null, channel, `Status ${key}: need ${need}, have ${have}, %${progress}`)
          })
        }
        return status(function (err, msg) {
          sendMessage(err, channel, msg)
        })
    }
  })
}

function sendMessage (err, channel, msg) {
  if (err) return client.say(channel, 'Error: ' + err.message)
  client.say(channel, msg)
}

function archiveSync (feed) {
  var key = feed.key.toString('hex')
  var channel = pending[key] ? pending[key].channel : null
  delete pending[key]

  console.log('Feed archived', key)
  if (client && channel) {
    var size = feed.content ? content.byteLength : feed.byteLength
    var msg = key + ' has been fully archived (' + prettyBytes(size) + ')'
    sendMessage(null, channel, msg)
  }
}

function status (cb) {
  var cnt = 0
  ar.list(function (err, keys) {
    if (err) return cb(err)
    cb(null, 'Uptime: ' + prettyTime(process.hrtime(started)) + '. Archiving ' + keys.length + ' hypercores.')
  })
}

function statusKey (key, cb) {
  ar.get(key, function (err, feed, content) {
    if (err) return cb(err)
    if (!content) content = {length: 0}
    var need = feed.length + content.length
    var have = need - blocksRemain(feed) - blocksRemain(content)
    return cb(null, { key: key, need: need, have: have })
  })

  function blocksRemain (feed) {
    if (!feed.length) return 0
    var remaining = 0
    for (var i = 0; i < feed.length; i++) {
      if (!feed.has(i)) remaining++
    }
    return remaining
  }
}

function parse (message) {
  message = message.trim()

  if (message[0] === '!') {
    message = message.slice(1)
  } else {
    var name = (message.indexOf(':') > -1 ? message.split(':')[0] : '').trim().replace(/\d+$/, '')
    if (name !== argv.name) return null
  }

  message = message.split(':').pop().trim()
  if (message.indexOf(' ') === -1) return {command: message, key: null}
  var parts = message.split(' ')
  if (!/^[0-9a-f]{64}$/.test(parts[1])) return null
  return {
    command: parts[0],
    key: parts[1]
  }
}
