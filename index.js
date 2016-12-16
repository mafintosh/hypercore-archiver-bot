#!/usr/bin/env node

var archiver = require('hypercore-archiver')
var irc = require('irc')
var mkdirp = require('mkdirp')
var minimist = require('minimist')
var defaults = require('datland-swarm-defaults')
var disc = require('discovery-channel')(defaults({hash: false}))
var net = require('net')
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
    port: 'p'
  },
  default: {
    port: 3282,
    cwd: 'hypercore-archiver',
    name: 'archive-bot',
    server: 'irc.freenode.net'
  }
})

mkdirp.sync(argv.cwd)

var started = process.hrtime()
var ar = archiver(argv.cwd)
var server = net.createServer(function (socket) {
  pump(socket, ar.replicate({passive: true}), socket)
})

server.listen(argv.port, function () {
  ar.list().on('data', function (key) {
    setTimeout(join, Math.floor(Math.random() * 30 * 1000))

    function join () {
      console.log('Joining', key.toString('hex'))
      disc.join(ar.discoveryKey(key), server.address().port)
    }
  })

  ar.changes(function (err, feed) {
    if (err) throw err
    disc.join(feed.discoveryKey, server.address().port)
    console.log('Changes feed available at: ' + feed.key.toString('hex'))
    console.log('Listening on port', server.address().port)
  })
})

var client = null

if (argv.channel) {
  var ircOpts = extend({}, argv, {
    channels: [argv.channel],
    retryCount: 1000,
    autoRejoin: true
  })
  ircOpts.port = argv.ircPort

  console.log('Connecting to IRC', argv.server)
  client = new irc.Client(argv.server, argv.name, ircOpts)

  client.on('registered', function (msg) {
    console.log('Connected to IRC, listening for messages')
  })

  client.on('message', function (from, to, message) {
    var op = parse(message)
    if (!op) return
    switch (op.command) {
      case 'add': return add(new Buffer(op.key, 'hex'))
      case 'rm':
      case 'remove': return remove(new Buffer(op.key, 'hex'))
      case 'status': return status()
    }
  })
}

ar.on('archived', function (key, feed) {
  var msg = key.toString('hex') + ' has been fully archived (' + prettyBytes(feed.bytes) + ')'
  if (client) client.say(argv.channel, msg)
  console.log(msg)
})

ar.on('remove', function (key) {
  console.log('Removing', key.toString('hex'))
  if (client) client.say(argv.channel, 'Removing ' + key.toString('hex'))
  disc.leave(ar.discoveryKey(key), server.address().port)
})

ar.on('add', function (key) {
  console.log('Adding', key.toString('hex'))
  if (client) client.say(argv.channel, 'Adding ' + key.toString('hex'))
  disc.join(ar.discoveryKey(key), server.address().port)
})

function status () {
  var cnt = 0
  ar.list().on('data', ondata).on('end', reply).on('error', onerror)

  function ondata () {
    cnt++
  }

  function reply () {
    client.say(argv.channel, 'Uptime: ' + prettyTime(process.hrtime(started)) + '. Archiving ' + cnt + ' hypercores')
  }
}

function add (key) {
  ar.add(key, onerror)
}

function remove (key) {
  ar.remove(key, onerror)
}

function onerror (err) {
  if (err) {
    console.error('Error: ' + err.message)
    if (client) client.say(argv.channel, 'Error: ' + err.message)
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
