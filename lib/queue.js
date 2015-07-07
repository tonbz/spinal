var Kue = require('kue')
var URLparse = require('url').parse
var debug = require('debug')('spinal:queue')
var _ = require('lodash')
var _Kues = []

/* istanbul ignore next */
var shutdown = function(sig) {
  console.log('----- Got terminate signal -----')
  for (var i in _Kues) {
    _Kues[i].shutdown(3000, function(err) {
      if(err) console.log('Kue shutdown err: ', err)
      process.exit(0)
    })
  }
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

var Queue = function(options) {
  options = options || {}
  var that = this
  this.router = options.router
  this.job_names = []
  this.queues = {}
  this.redis_config = {}
  this.q = Kue.createQueue({
    prefix: 'q',
    redis: {
      host: '127.0.0.1',
      port: options.redis
    }
  })
  _Kues.push(this.q)
  // Kue.app.listen(3000)
}

Queue.prototype.addWorker = function(name) {
  if (this.job_names.indexOf(name) > -1) return false
  debug('Add worker `' + name + '`')
  this.job_names.push(name)
  this.q.process(name, this.jobFn(name))
}

Queue.prototype.jobFn = function(name){
  var that = this
  return function(job, done){
    that.router.call(name + ':worker', job.data, {},
      function(err, result, options, job_options){
        if (job_options.logs){
          for (var i = 0; i < job_options.logs.length; i++) {
            job.log(job_options.logs[i])
          }
        }
        done(err)
      })
  }
}

Queue.prototype.addJob = function(name, data, options, fn) {
  debug('Add job `' + name + '` ' + JSON.stringify(data))
  // if (!this.queues[name]) return false
  var job = this.q.create(name, data)
    .priority(options.priority || 'normal')
    .attempts(options.attempts || 2)
    .ttl(options.ttl || 30000) // 30s
    .backoff(options.backoff)
    .delay(options.delay)
    .save(fn)
  return job
}

/* istanbul ignore next */
Queue.prototype.setConcurrent = function(name, concurrency) {
  var group = _.groupBy(this.q.workers, function(n){ return n.type })
  var that = this
  for (var type in group) {
    if (type == name) {
      var count = group[type].length
      if (count < concurrency){
        debug('Increase concurrent worker `' + name + '` ' + count + '->' + concurrency)
        for (var i = count; i < concurrency; i++) {
          debug('New worker ' + name + '(' + i + ')')
          this.q.process(name, this.jobFn(name))
        }
      } else if (count == concurrency) {
        debug('Does not adjust concurrent worker `' + name + '`')
      } else {
        debug('Decrease concurrent worker `' + name + '` ' + count + '->' + concurrency)
        for (var i = count-1; i >= concurrency; i--) {
          var work = group[name][i]
          for (var j = 0; j < this.q.workers.length; j++) {
            if (this.q.workers[j].id === work.id){
              that.q.workers.splice(j, 1)
              ;(function(i, j) {
                work.shutdown(function(){
                  debug('Drop worker ' + name + '(' + i + ')')
                })
              })(i, j)
              break
            }
          }
        }
      }
    }
  }
}

Queue.prototype.onstop = function() {
  this.q.shutdown()
}


module.exports = Queue