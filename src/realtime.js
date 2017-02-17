import { _deepExtend } from './lib/deepextend';
import defer           from 'promise-defer';
import 'jquery';
import 'socket.io-client';

let WisemblyRealTime = function (options) {
  this.init(options);
};

WisemblyRealTime.version = __VERSION__;

WisemblyRealTime.prototype = {
  init: function (options) {
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

  setOptions: function (options) {
    this.options = Object.assign({}, this.options, options);

    if (this.options.apiToken && this.offlineContext) {
      let offlineContext = this.offlineContext;
      this.offlineContext = null;
      this.join(offlineContext);
    }
  },

  connect: function (options) {
    // console.log('[realtime]', 'connect', this.options);
    switch (this.states['push']) {
      case 'connected':
        return Promise.resolve();
      case 'connecting':
        return this.getPromise('push:connecting').promise();
    }

    let dfd = defer();

    this.setState('push', 'connecting');
    this.storePromise('push:connecting', dfd);
    this.socket = io(this.options.server.toString(), this.options);
    this.bindSocketEvents();

    if (this.options.apiToken) {
      let offlineContext = this.offlineContext;
      this.offlineContext = null;
      this.join(offlineContext);
    }

    return dfd.promise
      .then(() => {
        this.trigger('connected', Object.assign({}, { states: this.states }, options));
        this.startActivityMonitor();
      });
  },

  disconnect: function (options) {
    // console.log('[realtime] disconnect');
    if (this.getState() === 'offline')
      return Promise.resolve();

    if (this.states['push'] === 'disconnecting')
      return this.getPromise('push:disconnecting').promise;

    let dfd = defer();

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

    return dfd.promise
      .then(() => {
        this.setStates({ push: 'offline', polling: 'offline' });
        this.socket = null;
        this.rooms = [];
        this.analytics = [];
        this.promises = {};
        this.events = {};
        this.entities = {};
        this.trigger('disconnected', Object.assign({}, { states: this.states }, options));
      });
  },

  ping: function () {
    let dfd = defer();

    this.socket.emit('_ping', { timestamp: +(new Date()) } , (name, data) => {
      if ('_pong' !== name) {
        dfd.promise.reject();
      } else {
        this.trigger('_pong', data);
        dfd.promise.resolve(data);
      }
    });
    return dfd.promise;
  },


  /*
   * Rooms
   */

  joinFromPush: function (params) {
    // console.log('[realtime] joinFromPush', params);
    let dfd = defer();

    if (!this.socket) {
      dfd.promise.reject();
    } else {
      this.socket.emit('join', Object.assign({}, { token: this.options.apiToken }, params), (error, rooms, headers) => {
        headers = headers || {};
        if ('date' in headers)
          this.lastPullTime = this.lastPullTime || +(new Date(headers['date']));
        if (error) {
          console.log('[realtime] Unable to join rooms on the Wisembly websocket server', error, params);
          this.setState('polling', 'full');
          dfd.promise.reject(error);
        } else {
          console.log('[realtime] Successfully joined %d rooms on the Wisembly websocket server', rooms.length, rooms);
          this.setState('polling', 'medium');
          this.rooms = rooms;
          this.trigger('rooms', { rooms: this.rooms });
          dfd.promise.resolve(this.rooms);
        }
      });
    }
    return dfd.promise;
  },

  joinFromAPI: function (params) {
    // console.log('[realtime] joinFromAPI', params);
    let dfd = defer();
    let rooms = this.rooms;

    this.fetchRooms({ data: JSON.stringify(params) })
      .then((data, status, jqXHR) => {
        data = data.success || data;
        data = data.data || data;

        let fetchedRooms = data.rooms;

        fetchedRooms.forEach((room, index) => {
          if (!rooms.includes(room))
            rooms.push(room);
        });

        if (jqXHR.getResponseHeader('Date'))
          this.lastPullTime = this.lastPullTime || +(new Date(jqXHR.getResponseHeader('Date')));
        this.setState('polling', 'full');
        this.resolvePromise('polling:connecting');

        console.log('[realtime] Successfully retrieved %d rooms from Wisembly API', rooms.length, rooms);
        this.trigger('rooms', { rooms: rooms });
        dfd.promise.resolve(rooms);
      })
      .catch(dfd.promise.reject);
    return dfd.promise;
  },

  join: function (params) {
    // console.log('[realtime] join', params);
    let dfd = defer();

    if (!this.options.apiToken) {
      this.offlineContext = Object.assign({}, this.offlineContext, params);
      dfd.reject();
    } else switch (this.getState()) {
      case 'push:connected':
        this.joinFromPush(params)
          .then(dfd.promise.resolve)
          .catch(() => {
            this.joinFromAPI(params)
              .then(dfd.promise.resolve)
              .catch(dfd.promise.reject)
              .then(() => {
                this.startPushRejoin(0);
              });
          });
        break;
      case 'push:connecting':
        this.getPromise('push:connecting').then(() => {
          this.join(params)
            .then(dfd.promise.resolve)
            .catch(dfd.promise.reject);
        });
        break;
      case 'polling:connecting':
      case 'polling:full':
        this.joinFromAPI(params)
          .then(dfd.promise.resolve)
          .catch(dfd.promise.reject);
        break;
      default:
        this.offlineContext = Object.assign({}, this.offlineContext, params);
        dfd.promise.reject();
    }

    return dfd.promise;
  },

  leave: function (rooms) {
    // TODO
    return dfd.promise.reject();
  },

  /*
   * Analytics
   */

  addAnalytics: function (namespaces) {
    // console.log('[realtime] addAnalytics', namespaces);
    namespaces = !namespaces || Array.isArray(namespaces) ? namespaces : [ namespaces ];

    let dfd = defer();

    switch (this.getState()) {
      case 'push:connected':
        this.socket.emit('analytics:subscribe', namespaces || [], (error, namespaces) => {
          if (error) {
            dfd.promise.reject(error);
          } else {
            console.log('[realtime] Successfully joined %d analytics rooms on the Wisembly websocket server', namespaces.length);
            this.analytics = namespaces;
            dfd.promise.resolve(this.analytics);
          }
        });
        break;
      default:
        if (namespaces.length) {
          namespaces.forEach((namespace, index) => {
            if (!this.analytics.includes(namespace)) {
              this.analytics.push(namespace);
            }
          });
        }

        dfd.promise.resolve(this.analytics);

    }
    return dfd.promise;
  },

  removeAnalytics: function (namespaces) {
    // TODO
    return dfd.promise.reject();
  },

  /*
   * Push Events
   */

  addEvent: function (eventData) {
    this.events[eventData.hash] = true;
  },

  checkEvent: function (eventData) {
    // accept eventData if event not registered yet
    return !this.events.hasOwnProperty(eventData.hash);
  },

  handleEvent: function (eventData) {
    if (!this.checkEvent(eventData) || !this.checkEntity(eventData))
      return false;
    this.addEvent(eventData);
    this.addEntity(eventData);
    this.sendEvent(eventData);
    return true;
  },

  sendEvent: function (eventData) {
    // console.log('[realtime] sendEvent:', eventData.eventName, eventData);
    this.startActivityMonitor();
    this.trigger('event', eventData);
  },

  startActivityMonitor: function () {
    if (!this.options.inactivityTimeout)
      return;

    clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => {
      this.trigger('inactivity', { timeout: this.options.inactivityTimeout });
    }, this.options.inactivityTimeout);
  },

  stopActivityMonitor: function () {
    clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  },

  /*
   * Entities
   */

  addEntity: function (eventData) {
    let entity = eventData.data || {},
        entityClassName = entity.class_name,
        entityId = entity.id || entity.hash,
        identifier = entityClassName && entityId ? entityClassName + ':' + entityId : null,
        time = eventData.time;

    if (identifier && time) {
      this.entities[identifier] = time;
    }
  },

  checkEntity: function(eventData) {
    let entity = eventData.data || {},
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

  startPushRejoin: function (intervall) {
    if (this.states['push'] !== 'connected')
      return;
    // console.log('[realtime] startPushRejoin', this.states['push']);
    let nbAttemps = 0;
    function fnRejoinRequest(intervall) {
      let promise = this.rooms.length ? this.joinFromPush({ rooms: this.rooms }) : Promise.resolve();
      promise
        .then(() => {
          this.addAnalytics(this.analytics);
        })
        .catch(() => {
          if (++nbAttemps < this.options.reconnectionAttempts)
            fnRejoinIntervall(intervall + this.options.reconnectionDelay);
        });
      return promise;
    }

    function fnRejoinIntervall(intervall) {
      if (this.states['push'] !== 'connected')
        return;
      intervall = Math.min(intervall || 0, this.options.reconnectionDelayMax);
      clearTimeout(this.pushRejoinTimer);
      this.pushRejoinTimer = setTimeout(() => {
        fnRejoinRequest(intervall);
      }, intervall);
    }

    clearTimeout(this.pushRejoinTimer);
    fnRejoinIntervall(intervall);
  },

  stopPushRejoin: function () {
    clearTimeout(this.pushRejoinTimer);
    this.pushRejoinTimer = null;
  },

  getPushTransport: function () {
    if (this.states['push'] !== 'connected')
      return null;
    return !!this.socket.io.engine.transport.ws ? 'websocket' : 'polling';
  },

  /*
   * Polling
   */

  startPolling: function () {
    if (this.states['polling'] === 'offline')
      return;
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

  stopPolling: function () {
    clearTimeout(this.pullTimer);
    this.pullTimer = null;
    this.setState('polling', 'offline');
  },

  pull: function() {
    if (this.pullXHR)
      return this.pullXHR;

    this.pullXHR = this.fetchPullEvents();
    return this.pullXHR
      .then((data) => {
        data = data.success || data;
        data = data.data || data;

        if (data.data && data.data.length) {
          data.data.forEach((eventData, index) => {
            if (this.handleEvent(Object.assign({}, eventData, { via: 'polling' })) && this.states['polling'] !== 'full')
                this.trigger('missed', eventData);
          })
        }

        this.lastPullTime = data.since > (this.lastPullTime || 0) ? data.since : this.lastPullTime;
      })
      .then(() => {
        this.pullXHR = null;
      });
  },

  /*
   * Socket
   */

  bindSocketEvents: function() {
    this.socket.on('broadcast', () => {
      this.onSocketBroadcast.apply(this, arguments);
    });

    this.socket.on('uuid', () => {
      console.log('[realtime] Your unique connection ID is: ' + data.uuid);
      this.onSocketUuid.apply(this, arguments);
    });

    this.socket.on('connect', () => {
      console.log('[realtime] Welcome to the Wisembly websocket server');
      this.onSocketConnect.apply(this, arguments);
    });

    this.socket.on('connect_error', () => {
      console.log('[realtime] Cannot connect to websocket server');
      this.onSocketConnectError.apply(this, arguments);
    });

    this.socket.on('disconnect', () => {
      console.log('[realtime] Disconnected from the Wisembly websocket server');
      this.onSocketDisconnect.apply(this, arguments);
    });

    this.socket.on('reconnecting', () => {
      console.log('[realtime] Reconnecting to the Wisembly websocket server');
      this.onSocketReconnecting.apply(this, arguments);
    });

    this.socket.on('reconnect', () => {
      console.log('[realtime] Reconnected to the Wisembly websocket server');
      this.onSocketReconnect.apply(this, arguments);
    });

    this.socket.on('analytics', (data) => {
      data = data || {};
      // console.log('[realtime] Analytics', data.room, data.usersCount);
      this.onSocketAnalytics.apply(this, arguments);
    });
  },

  onSocketBroadcast: function (data) {
    let _data = JSON.parse(data);
    this.handleEvent(Object.assign({}, _data, { via: 'socket' }));
  },

  onSocketConnect: function () {
    this.trigger('pushUp');
    this.setStates({ push: 'connected', polling: 'medium' });
    this.resolvePromise('push:connecting');
  },

  onSocketUuid: function (data) {
    this.uuid = data.uuid;
  },

  onSocketConnectError: function (error) {
    this.onSocketDisconnect(error);
    this.resolvePromise('push:connecting');
  },

  onSocketDisconnect: function (error) {
    this.trigger('pushDown');
    this.resolvePromise('push:disconnecting')
      .catch(() => {
        this.setStates({ push: 'offline', polling: 'full' });
      });
  },

  onSocketReconnecting: function () {
    this.setState('push', 'connecting');
  },

  onSocketReconnect: function () {
    this.onSocketConnect();
  },

  onSocketAnalytics: function (data) {
    this.trigger('analytics', data);
  },

  /*
   * API
   */

  buildURL: function (path) {
    if (!this.options.apiHost || !this.options.apiNamespace)
      return null;
    let url = this.options.apiHost.toString() + '/' + this.options.apiNamespace.toString() + '/' + path;
    return url.replace(/([^:]\/)\//g, function ($0, $1) { return $1; });
  },

  apiRequest: (path, options) => {
    let token = this.options.apiToken,
        url = this.buildURL(path);

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

    return new Promise((resolve, reject) => {

      if (!url || !token)
        reject(Error('No URL or token'));

      let request = new XMLHttpRequest();

      let requestHeaders = Object.assign({
        "Content-Type": options.contentType,
        "Cache-Control": !options.cache ? "max-age=0" : options.cache
      }, options.headers);

      request.open(options.type, options.url, true);

      for (key in requestHeaders) {
        request.setRequestHeader(header, requestHeaders[key]);
      }

      request.responseType(options.dataType);

      request.onreadystatechange = () => {
        if (request.status == 200) {

          resolve(request.response);

        } else {

          let response = JSON.parse(request.response);
          let errorMessage = response.error && response.error.message;

          let data = Object.assign(
            { request: Object.assign({}, { path: path, token: token }, options) },
            errorMessage ? errorMessage : {}
          );
          this.trigger('error', data);
          reject(Error(request.statusText));

        }
      }

      request.onerror = () => {
        this.trigger('error');
        reject(Error('Network error'));
      };

      request.ontimeout = () => {
        this.trigger('error');
        reject(Error('Timeout'));
      };

      if (options.get === 'GET') {
        request.send();
      } else {
        request.send(options.data);
      }
    });
  },

  fetchRooms: function (options) {
    return this.apiRequest('users/node/credentials', Object.assign({}, {
      type: 'POST'
    }, options));
  },

  fetchPullEvents: function (options) {
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

  storePromise: function (name, dfd) {
    return (this.promises[name] = dfd);
  },

  getPromise: function (name) {
    return this.promises[name] || $.Deferred().reject();
  },

  resolvePromise: function (name) {
    let dfd = this.getPromise(name);

    if (dfd.state() === 'pending')
      dfd.promise.resolve();

    return dfd.promise.then(() => {
      delete this.promises[name];
    });
  },

  /*
   * State
   */

  setStates: function (states) {
    if (states['push'] === this.states['push'] && states['polling'] === this.states['polling'])
      return;
    // store previous states
    let previousStates = this.states;
    // update states
    this.states = states;

    // retrieve current state
    let state = this.getState();

    // on current state changed
    if (this.state !== state) {
      // store previous state
      let previousState = this.state;
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

  setState: function (mode, state) {
    // console.log('[realtime] setState', mode, state);
    let states = {
      push: this.states['push'],
      polling: this.states['polling']
    };
    states[mode] = state;
    this.setStates(states);
  },

  getState: function () {
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

  on: function (name, handler, context, once) {
    if (context === null)
      context = undefined;

    if (!this.__bindings.hasOwnProperty(name))
      this.__bindings[name] = [];

    this.__bindings[name] = this.__bindings[name].concat([{
      handler: handler, context: context, once: Boolean(once)
    }]);
  },

  off: function (name, handler, context) {
    if (context === null)
      context = undefined;

    if (!this.__bindings.hasOwnProperty(name))
      return;

    for (let filteredListeners = [], t = 0, T = this.__bindings[name].length; t < T; ++ t)
      if (this.__bindings[name][t].handler !== handler || this.__bindings[name][t].context !== context)
        filteredListeners.push(this.__bindings[name][t]);

    this.__bindings[name] = filteredListeners;
  },

  once: function (name, handler, context) {
    this.on(name, handler, context, true);
  },

  trigger: function (name) {
    if (!this.__bindings.hasOwnProperty(name))
      return;

    // Avoid Array.prototype.slice.call(arguments) to keep the function optimized
    // Also: we start at 1 instead of 0 so that we avoid copying the "name" argument
    for (let args = [], t = 1, T = arguments.length; t < T; ++ t)
      args.push(arguments[t]);

    let listeners = this.__bindings[name];

    // Remove every "once" listener before actually running them so they will always be called for THIS event only
    for (let t = 0, T = listeners.length; t < T; ++ t)
      if (listeners[t].once)
        this.off(name, listeners[t].handler, listeners[t].context);

    // Finally dispatch the events to the listeners
    for (let t = 0, T = listeners.length; t < T; ++ t) {
      listeners[t].handler.apply(listeners[t].context, args);
    }
  }
};

module.exports = WisemblyRealTime;
