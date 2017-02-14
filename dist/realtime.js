'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var _Promise = typeof Promise === 'undefined' ? require('es6-promise').Promise : Promise;

/*global define,require,module*/

(function (factory) {

  if (typeof define !== 'undefined' && define.amd) {

    define(['jquery', 'socket.io-client', 'promise-defer'], factory);
  } else if (typeof module !== 'undefined') {

    module.exports = factory(require('jquery'), require('socket.io-client'), require('promise-defer'));
  } else if (typeof window !== 'undefined') {

    if (typeof window.$ !== 'undefined' && typeof window.io !== 'undefined') {
      window.WisemblyRealTime = factory(window.$, window.io);
    } else if (typeof require !== 'undefined') {
      window.WisemblyRealTime = factory(require('jquery'), require('socket.io-client'), require('promise-defer'));
    }
  } else {

    throw new Error('Unsupported environment');
  }
})(function ($, io, defer) {
  var _arguments = arguments,
      _this13 = this;

  // http://youmightnotneedjquery.com/
  var _deepExtend = function _deepExtend(out) {
    out = out || {};

    for (var i = 1; i < _arguments.length; i++) {
      var obj = _arguments[i];

      if (!obj) continue;

      for (var _key in obj) {
        if (obj.hasOwnProperty(_key)) {
          if (_typeof(obj[_key]) === 'object') out[_key] = _deepExtend(out[_key], obj[_key]);else out[_key] = obj[_key];
        }
      }
    }

    return out;
  };

  var WisemblyRealTime = function WisemblyRealTime(options) {
    this.init(options);
  };

  WisemblyRealTime.version = '0.3.0';

  WisemblyRealTime.prototype = {
    init: function init(options) {
      this.mode = null;

      this.state = 'offline';
      this.states = {
        push: 'offline',
        polling: 'offline'
      };

      this.__bindings = {};

      this.uuid = '------------------------------------';
      this.promises = {};
      this.rooms = [];
      this.analytics = [];
      this.events = {};
      this.entities = {};

      // set options
      this.options = {
        apiHost: null,
        apiNamespace: 'api/4/',
        apiToken: null,
        server: null,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 60000,
        pullInterval: 10000,
        pullIntervalEnhance: 60000,
        forceNew: true,
        inactivityTimeout: 0,
        transports: ['websocket', 'polling']
        //'secure': true
      };
      this.setOptions(options);
    },

    setOptions: function setOptions(options) {
      this.options = Object.assign({}, this.options, options);

      if (this.options.apiToken && this.offlineContext) {
        var offlineContext = this.offlineContext;
        this.offlineContext = null;
        this.join(offlineContext);
      }
    },

    connect: function connect(options) {
      var _this = this;

      // console.log('[realtime]', 'connect', this.options);
      switch (this.states['push']) {
        case 'connected':
          return _Promise.resolve();
        case 'connecting':
          return this.getPromise('push:connecting').promise();
      }

      var dfd = defer();

      this.setState('push', 'connecting');
      this.storePromise('push:connecting', dfd);
      this.socket = io(this.options.server.toString(), this.options);
      this.bindSocketEvents();

      if (this.options.apiToken) {
        var offlineContext = this.offlineContext;
        this.offlineContext = null;
        this.join(offlineContext);
      }

      return dfd.promise.then(function () {
        _this.trigger('connected', Object.assign({}, { states: _this.states }, options));
        _this.startActivityMonitor();
      });
    },

    disconnect: function disconnect(options) {
      var _this2 = this;

      // console.log('[realtime] disconnect');
      if (this.getState() === 'offline') return _Promise.resolve();

      if (this.states['push'] === 'disconnecting') return this.getPromise('push:disconnecting').promise;

      var dfd = defer();

      // disconnect socket
      if (this.socket && this.socket.connected) {
        this.setState('push', 'disconnecting');
        this.storePromise('push:disconnecting', dfd);
        this.socket.disconnect();
      } else {
        dfd.promise.resolve();
      }

      this.stopPushRejoin();

      // stop polling
      this.stopPolling();

      this.offlineContext = null;

      return dfd.promise.then(function () {
        _this2.setStates({ push: 'offline', polling: 'offline' });
        _this2.socket = null;
        _this2.rooms = [];
        _this2.analytics = [];
        _this2.promises = {};
        _this2.events = {};
        _this2.entities = {};
        _this2.trigger('disconnected', Object.assign({}, { states: _this2.states }, options));
      });
    },

    ping: function ping() {
      var _this3 = this;

      var dfd = defer();

      this.socket.emit('_ping', { timestamp: +new Date() }, function (name, data) {
        if ('_pong' !== name) {
          dfd.promise.reject();
        } else {
          _this3.trigger('_pong', data);
          dfd.promise.resolve(data);
        }
      });
      return dfd.promise;
    },

    /*
     * Rooms
     */
    joinFromPush: function joinFromPush(params) {
      var _this4 = this;

      // console.log('[realtime] joinFromPush', params);
      var dfd = defer();

      if (!this.socket) {
        dfd.promise.reject();
      } else {
        this.socket.emit('join', Object.assign({}, { token: this.options.apiToken }, params), function (error, rooms, headers) {
          headers = headers || {};
          if ('date' in headers) _this4.lastPullTime = _this4.lastPullTime || +new Date(headers['date']);
          if (error) {
            console.log('[realtime] Unable to join rooms on the Wisembly websocket server', error, params);
            _this4.setState('polling', 'full');
            dfd.promise.reject(error);
          } else {
            console.log('[realtime] Successfully joined %d rooms on the Wisembly websocket server', rooms.length, rooms);
            _this4.setState('polling', 'medium');
            _this4.rooms = rooms;
            _this4.trigger('rooms', { rooms: _this4.rooms });
            dfd.promise.resolve(_this4.rooms);
          }
        });
      }
      return dfd.promise;
    },

    joinFromAPI: function joinFromAPI(params) {
      var _this5 = this;

      // console.log('[realtime] joinFromAPI', params);
      var dfd = defer();
      var rooms = this.rooms;

      this.fetchRooms({ data: JSON.stringify(params) }).then(function (data, status, jqXHR) {
        data = data.success || data;
        data = data.data || data;

        var fetchedRooms = data.rooms;

        fetchedRooms.forEach(function (room, index) {
          if (!rooms.includes(room)) rooms.push(room);
        });

        if (jqXHR.getResponseHeader('Date')) _this5.lastPullTime = _this5.lastPullTime || +new Date(jqXHR.getResponseHeader('Date'));
        _this5.setState('polling', 'full');
        _this5.resolvePromise('polling:connecting');

        console.log('[realtime] Successfully retrieved %d rooms from Wisembly API', rooms.length, rooms);
        _this5.trigger('rooms', { rooms: rooms });
        dfd.promise.resolve(rooms);
      }).catch(dfd.promise.reject);
      return dfd.promise;
    },

    join: function join(params) {
      var _this6 = this;

      // console.log('[realtime] join', params);
      var dfd = defer();

      if (!this.options.apiToken) {
        this.offlineContext = Object.assign({}, this.offlineContext, params);
        dfd.reject();
      } else switch (this.getState()) {
        case 'push:connected':
          this.joinFromPush(params).then(dfd.promise.resolve).catch(function () {
            _this6.joinFromAPI(params).then(dfd.promise.resolve).catch(dfd.promise.reject).then(function () {
              _this6.startPushRejoin(0);
            });
          });
          break;
        case 'push:connecting':
          this.getPromise('push:connecting').then(function () {
            _this6.join(params).then(dfd.promise.resolve).catch(dfd.promise.reject);
          });
          break;
        case 'polling:connecting':
        case 'polling:full':
          this.joinFromAPI(params).then(dfd.promise.resolve).catch(dfd.promise.reject);
          break;
        default:
          this.offlineContext = Object.assign({}, this.offlineContext, params);
          dfd.promise.reject();
      }

      return dfd.promise;
    },

    leave: function leave(rooms) {
      // TODO
      return dfd.promise.reject();
    },

    /*
     * Analytics
     */

    addAnalytics: function addAnalytics(namespaces) {
      var _this7 = this;

      // console.log('[realtime] addAnalytics', namespaces);
      namespaces = !namespaces || Array.isArray(namespaces) ? namespaces : [namespaces];

      var dfd = defer();

      switch (this.getState()) {
        case 'push:connected':
          this.socket.emit('analytics:subscribe', namespaces || [], function (error, namespaces) {
            if (error) {
              dfd.promise.reject(error);
            } else {
              console.log('[realtime] Successfully joined %d analytics rooms on the Wisembly websocket server', namespaces.length);
              _this7.analytics = namespaces;
              dfd.promise.resolve(_this7.analytics);
            }
          });
          break;
        default:
          if (namespaces.length) {
            namespaces.forEach(function (namespace, index) {
              if (!_this7.analytics.includes(namespace)) {
                _this7.analytics.push(namespace);
              }
            });
          }

          dfd.promise.resolve(this.analytics);

      }
      return dfd.promise;
    },

    removeAnalytics: function removeAnalytics(namespaces) {
      // TODO
      return dfd.promise.reject();
    },

    /*
     * Push Events
     */

    addEvent: function addEvent(eventData) {
      this.events[eventData.hash] = true;
    },

    checkEvent: function checkEvent(eventData) {
      // accept eventData if event not registered yet
      return !this.events.hasOwnProperty(eventData.hash);
    },

    handleEvent: function handleEvent(eventData) {
      if (!this.checkEvent(eventData) || !this.checkEntity(eventData)) return false;
      this.addEvent(eventData);
      this.addEntity(eventData);
      this.sendEvent(eventData);
      return true;
    },

    sendEvent: function sendEvent(eventData) {
      // console.log('[realtime] sendEvent:', eventData.eventName, eventData);
      this.startActivityMonitor();
      this.trigger('event', eventData);
    },

    startActivityMonitor: function startActivityMonitor() {
      var _this8 = this;

      if (!this.options.inactivityTimeout) return;

      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = setTimeout(function () {
        _this8.trigger('inactivity', { timeout: _this8.options.inactivityTimeout });
      }, this.options.inactivityTimeout);
    },

    stopActivityMonitor: function stopActivityMonitor() {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    },

    /*
     * Entities
     */

    addEntity: function addEntity(eventData) {
      var entity = eventData.data || {},
          entityClassName = entity.class_name,
          entityId = entity.id || entity.hash,
          identifier = entityClassName && entityId ? entityClassName + ':' + entityId : null,
          time = eventData.time;

      if (identifier && time) {
        this.entities[identifier] = time;
      }
    },

    checkEntity: function checkEntity(eventData) {
      var entity = eventData.data || {},
          entityClassName = entity.class_name,
          entityId = entity.id || entity.hash,
          identifier = entityClassName && entityId ? entityClassName + ':' + entityId : null,
          time = eventData.time;

      // accept eventData if :
      // not a valid entity (no id/hash and no class_name) OR not a valid eventData (no milliseconds) OR entity not registered yet OR last entity update done before this event
      return !identifier || !time || !this.entities.hasOwnProperty(identifier) || time >= this.entities[identifier];
    },

    /*
     * Push
     */

    startPushRejoin: function startPushRejoin(intervall) {
      if (this.states['push'] !== 'connected') return;
      // console.log('[realtime] startPushRejoin', this.states['push']);
      var nbAttemps = 0;
      function fnRejoinRequest(intervall) {
        var _this9 = this;

        var promise = this.rooms.length ? this.joinFromPush({ rooms: this.rooms }) : _Promise.resolve();
        promise.then(function () {
          _this9.addAnalytics(_this9.analytics);
        }).catch(function () {
          if (++nbAttemps < _this9.options.reconnectionAttempts) fnRejoinIntervall(intervall + _this9.options.reconnectionDelay);
        });
        return promise;
      }

      function fnRejoinIntervall(intervall) {
        if (this.states['push'] !== 'connected') return;
        intervall = Math.min(intervall || 0, this.options.reconnectionDelayMax);
        clearTimeout(this.pushRejoinTimer);
        this.pushRejoinTimer = setTimeout(function () {
          fnRejoinRequest(intervall);
        }, intervall);
      }

      clearTimeout(this.pushRejoinTimer);
      fnRejoinIntervall(intervall);
    },

    stopPushRejoin: function stopPushRejoin() {
      clearTimeout(this.pushRejoinTimer);
      this.pushRejoinTimer = null;
    },

    getPushTransport: function getPushTransport() {
      if (this.states['push'] !== 'connected') return null;
      return !!this.socket.io.engine.transport.ws ? 'websocket' : 'polling';
    },

    /*
     * Polling
     */

    startPolling: function startPolling() {
      if (this.states['polling'] === 'offline') return;
      // console.log('[realtime] startPolling', this.states['polling']);

      function fnPullRequest() {
        return this.pull().then(fnPullIntervall);
      }

      function fnPullIntervall() {
        clearTimeout(this.pullTimer);
        switch (this.states['polling']) {
          case 'full':
            this.pullTimer = setTimeout(fnPullRequest, this.options.pullInterval);
            break;
          case 'medium':
            this.pullTimer = setTimeout(fnPullRequest, this.options.pullIntervalEnhance);
            break;
        }
      }

      clearTimeout(this.pullTimer);
      fnPullRequest();
    },

    stopPolling: function stopPolling() {
      clearTimeout(this.pullTimer);
      this.pullTimer = null;
      this.setState('polling', 'offline');
    },

    pull: function pull() {
      var _this10 = this;

      if (this.pullXHR) return this.pullXHR;

      this.pullXHR = this.fetchPullEvents();
      return this.pullXHR.then(function (data) {
        data = data.success || data;
        data = data.data || data;

        if (data.data && data.data.length) {
          data.data.forEach(function (eventData, index) {
            if (_this10.handleEvent(Object.assign({}, eventData, { via: 'polling' })) && _this10.states['polling'] !== 'full') _this10.trigger('missed', eventData);
          });
        }

        _this10.lastPullTime = data.since > (_this10.lastPullTime || 0) ? data.since : _this10.lastPullTime;
      }).then(function () {
        _this10.pullXHR = null;
      });
    },

    /*
     * Socket
     */

    bindSocketEvents: function bindSocketEvents() {
      var _this11 = this,
          _arguments2 = arguments;

      this.socket.on('broadcast', function () {
        _this11.onSocketBroadcast.apply(_this11, _arguments2);
      });

      this.socket.on('uuid', function () {
        console.log('[realtime] Your unique connection ID is: ' + data.uuid);
        _this11.onSocketUuid.apply(_this11, _arguments2);
      });

      this.socket.on('connect', function () {
        console.log('[realtime] Welcome to the Wisembly websocket server');
        _this11.onSocketConnect.apply(_this11, _arguments2);
      });

      this.socket.on('connect_error', function () {
        console.log('[realtime] Cannot connect to websocket server');
        _this11.onSocketConnectError.apply(_this11, _arguments2);
      });

      this.socket.on('disconnect', function () {
        console.log('[realtime] Disconnected from the Wisembly websocket server');
        _this11.onSocketDisconnect.apply(_this11, _arguments2);
      });

      this.socket.on('reconnecting', function () {
        console.log('[realtime] Reconnecting to the Wisembly websocket server');
        _this11.onSocketReconnecting.apply(_this11, _arguments2);
      });

      this.socket.on('reconnect', function () {
        console.log('[realtime] Reconnected to the Wisembly websocket server');
        _this11.onSocketReconnect.apply(_this11, _arguments2);
      });

      this.socket.on('analytics', function (data) {
        data = data || {};
        // console.log('[realtime] Analytics', data.room, data.usersCount);
        _this11.onSocketAnalytics.apply(_this11, _arguments2);
      });
    },

    onSocketBroadcast: function onSocketBroadcast(data) {
      var _data = JSON.parse(data);
      this.handleEvent(Object.assign({}, _data, { via: 'socket' }));
    },

    onSocketConnect: function onSocketConnect() {
      this.trigger('pushUp');
      this.setStates({ push: 'connected', polling: 'medium' });
      this.resolvePromise('push:connecting');
    },

    onSocketUuid: function onSocketUuid(data) {
      this.uuid = data.uuid;
    },

    onSocketConnectError: function onSocketConnectError(error) {
      this.onSocketDisconnect(error);
      this.resolvePromise('push:connecting');
    },

    onSocketDisconnect: function onSocketDisconnect(error) {
      var _this12 = this;

      this.trigger('pushDown');
      this.resolvePromise('push:disconnecting').catch(function () {
        _this12.setStates({ push: 'offline', polling: 'full' });
      });
    },

    onSocketReconnecting: function onSocketReconnecting() {
      this.setState('push', 'connecting');
    },

    onSocketReconnect: function onSocketReconnect() {
      this.onSocketConnect();
    },

    onSocketAnalytics: function onSocketAnalytics(data) {
      this.trigger('analytics', data);
    },

    /*
     * API
     */

    buildURL: function buildURL(path) {
      if (!this.options.apiHost || !this.options.apiNamespace) return null;
      var url = this.options.apiHost.toString() + '/' + this.options.apiNamespace.toString() + '/' + path;
      return url.replace(/([^:]\/)\//g, function ($0, $1) {
        return $1;
      });
    },

    apiRequest: function apiRequest(path, options) {
      var token = _this13.options.apiToken,
          url = _this13.buildURL(path);

      options = _deepExtend({
        url: url,
        type: 'GET',
        dataType: 'json',
        contentType: 'application/json',
        headers: {
          'Wisembly-Token': token
        },
        cache: false
      }, options);

      return new _Promise(function (resolve, reject) {

        if (!url || !token) reject(Error('No URL or token'));

        var request = new XMLHttpRequest();

        var requestHeaders = Object.assign({
          "Content-Type": options.contentType,
          "Cache-Control": !options.cache ? "max-age=0" : options.cache
        }, options.headers);

        request.open(options.type, options.url, true);

        for (key in requestHeaders) {
          request.setRequestHeader(header, requestHeaders[key]);
        }

        request.responseType(options.dataType);

        request.onreadystatechange = function () {
          if (request.status == 200) {

            resolve(request.response);
          } else {

            var response = JSON.parse(request.response);
            var errorMessage = response.error && response.error.message;

            var _data2 = Object.assign({ request: Object.assign({}, { path: path, token: token }, options) }, errorMessage ? errorMessage : {});
            _this13.trigger('error', _data2);
            reject(Error(request.statusText));
          }
        };

        request.onerror = function () {
          _this13.trigger('error');
          reject(Error('Network error'));
        };

        request.ontimeout = function () {
          _this13.trigger('error');
          reject(Error('Timeout'));
        };

        if (options.get === 'GET') {
          request.send();
        } else {
          request.send(options.data);
        }
      });
    },

    fetchRooms: function fetchRooms(options) {
      return this.apiRequest('users/node/credentials', Object.assign({}, {
        type: 'POST'
      }, options));
    },

    fetchPullEvents: function fetchPullEvents(options) {
      return this.apiRequest('pull', {
        type: 'GET',
        data: {
          rooms: this.rooms,
          since: this.lastPullTime,
          enhanced: this.states['polling'] !== 'full'
        }
      });
    },

    /*
     * Promise
     */

    storePromise: function storePromise(name, dfd) {
      return this.promises[name] = dfd;
    },

    getPromise: function getPromise(name) {
      return this.promises[name] || $.Deferred().reject();
    },

    resolvePromise: function resolvePromise(name) {
      var _this14 = this;

      var dfd = this.getPromise(name);

      if (dfd.state() === 'pending') dfd.promise.resolve();

      return dfd.promise.then(function () {
        delete _this14.promises[name];
      });
    },

    /*
     * State
     */

    setStates: function setStates(states) {
      if (states['push'] === this.states['push'] && states['polling'] === this.states['polling']) return;
      // store previous states
      var previousStates = this.states;
      // update states
      this.states = states;

      // retrieve current state
      var state = this.getState();

      // on current state changed
      if (this.state !== state) {
        // store previous state
        var previousState = this.state;
        // store current state
        this.state = state;
        // console.log('[realtime] setStates:', states, state);
        // trigger 'state:update'
        this.trigger('state', { state: state, previous: previousState });
      }

      // on polling state changed
      if (previousStates['polling'] !== this.states['polling']) {
        this.startPolling();
      }

      // on push state changed
      if (previousStates['push'] !== this.states['push']) {
        this.startPushRejoin(0);
      }
    },

    setState: function setState(mode, state) {
      // console.log('[realtime] setState', mode, state);
      var states = {
        push: this.states['push'],
        polling: this.states['polling']
      };
      states[mode] = state;
      this.setStates(states);
    },

    getState: function getState() {
      switch (this.states['polling']) {
        case 'full':
        case 'connecting':
          return 'polling' + ':' + this.states['polling'];
      }
      switch (this.states['push']) {
        case 'connected':
        case 'connecting':
          return 'push' + ':' + this.states['push'];
      }
      return 'offline';
    },

    /*
     * Triggering
     */

    on: function on(name, handler, context, once) {
      if (context === null) context = undefined;

      if (!this.__bindings.hasOwnProperty(name)) this.__bindings[name] = [];

      this.__bindings[name] = this.__bindings[name].concat([{
        handler: handler, context: context, once: Boolean(once)
      }]);
    },

    off: function off(name, handler, context) {
      if (context === null) context = undefined;

      if (!this.__bindings.hasOwnProperty(name)) return;

      for (var _filteredListeners = [], t = 0, T = this.__bindings[name].length; t < T; ++t) {
        if (this.__bindings[name][t].handler !== handler || this.__bindings[name][t].context !== context) _filteredListeners.push(this.__bindings[name][t]);
      }this.__bindings[name] = filteredListeners;
    },

    once: function once(name, handler, context) {
      this.on(name, handler, context, true);
    },

    trigger: function trigger(name) {
      if (!this.__bindings.hasOwnProperty(name)) return;

      // Avoid Array.prototype.slice.call(arguments) to keep the function optimized
      // Also: we start at 1 instead of 0 so that we avoid copying the "name" argument
      for (var _args = [], t = 1, T = arguments.length; t < T; ++t) {
        _args.push(arguments[t]);
      }var listeners = this.__bindings[name];

      // Remove every "once" listener before actually running them so they will always be called for THIS event only
      for (var _t = 0, _T = listeners.length; _t < _T; ++_t) {
        if (listeners[_t].once) this.off(name, listeners[_t].handler, listeners[_t].context);
      } // Finally dispatch the events to the listeners
      for (var _t2 = 0, _T2 = listeners.length; _t2 < _T2; ++_t2) {
        listeners[_t2].handler.apply(listeners[_t2].context, args);
      }
    }
  };

  return WisemblyRealTime;
});