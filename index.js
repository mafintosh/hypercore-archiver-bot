#!/usr/bin/env node

var archiver = require('hypercore-archiver')
var irc = require('irc')
var mkdirp = require('mkdirp')
var minimist = require('minimist')
var defaults = require('dat-swarm-defaults')
var disc = require('discovery-channel')(defaults({hash: false}))
var archiverServer = require('archiver-server')
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
    port: 'p',
    ircPort: 'irc-port',
    announce: 'a'
  },
  default: {
    port: 3282,
    cwd: 'hypercore-archiver',
    name: 'archive-bot',
    server: 'irc.freenode.net',
    announce: false
  },
  boolean: ['announce']
})

mkdirp.sync(argv.cwd)

var started = process.hrtime()
var pending = []
var ar = archiver(argv.cwd)
var client = null
var server = null

if (argv.announce) {
  archiverServer(ar, {port: argv.port})
} else {
  server = net.createServer(function (socket) {
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
}

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
        pending.push({key: key, channel: channel})
        ar.add(new Buffer(key, 'hex'), {content: false}, function (err) {
          if (err) return sendMessage(err, channel)
          sendMessage(null, channel, 'Tracking ' + key)
        })
        return
      case 'add':
        pending.push({key: key, channel: channel})
        ar.add(new Buffer(key, 'hex'), function (err) {
          if (err) return sendMessage(err, channel)
          sendMessage(null, channel, 'Adding ' + key)
        })
        return
      case 'rm':
      case 'remove':
        pending = pending.filter(function (obj) {
          // remove meta keys + content keys
          return obj.key !== key && obj.metaKey !== key
        })
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

ar.on('archived', function (key, feed) {
  key = key.toString('hex')
  console.log('Feed archived', key)
  pending = pending.filter(function (obj) {
    if (key !== obj.key) return true
    if (!obj.metaKey) {
      waitForContent()
      return true
    }
    done(obj.metaKey, feed)
    return false
  })

  function waitForContent () {
    ar.get(key, function (_, feed, content) {
      if (!content) return done(key, feed)
      pending.push({key: content.key.toString('hex'), metaKey: key.toString('hex')})
    })
  }

  function done (key, feed) {
    pending = pending.filter(function (obj) {
      if (key !== obj.key) return true
      if (key === obj.metaKey) return false // remove content key from pending
      var msg = key + ' has been fully archived (' + prettyBytes(feed.byteLength) + ')'
      if (client) client.say(obj.channel, msg)
      console.log(msg)
      return false // remove meta key from pending
    })
  }
})

ar.on('remove', function (key) {
  console.log('Removing', key.toString('hex'))
  if (!argv.announce) disc.leave(ar.discoveryKey(key), server.address().port)
})

ar.on('add', function (key) {
  console.log('Adding', key.toString('hex'))
  if (!argv.announce) disc.join(ar.discoveryKey(key), server.address().port)
})

function status (cb) {
  var cnt = 0
  ar.list().on('data', ondata).on('end', reply).on('error', cb)

  function ondata () {
    cnt++
  }

  function reply () {
    cb(null, 'Uptime: ' + prettyTime(process.hrtime(started)) + '. Archiving ' + cnt + ' hypercores')
  }
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
      if (!feed.hash(i)) remaining++
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
