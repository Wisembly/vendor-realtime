(function ($) {

  window.WisemblyRealTime = function (options) {
    this.init(options);
  };

  window.WisemblyRealTime.version = '0.2.4';

  window.WisemblyRealTime.prototype = {
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
        client: 'https://cdn.socket.io/socket.io-1.2.1.js',
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
      this.options = $.extend({}, this.options, options);
    },

    getIOClient: function () {
      var self = this,
          dfd = $.Deferred();

      if (window.io || this.io) {
        dfd.resolve(window.io || this.io);
      } else {
        if (typeof require === 'function' && typeof define === 'function' && typeof define.amd === 'object') {
          require([this.options.client], dfd.resolve, dfd.reject);
        } else {
          $.ajax({ url: this.options.client, dataType: 'script', timeout: 5000 })
            .always(function () {
              dfd[window.io ? 'resolve' : 'reject'](window.io);
            });
        }
      }
      return dfd.promise().done(function (io) {
        // console.log('[realtime]', 'getIOClient', !!io);
        self.io = io;
      });
    },

    connect: function (options) {
      // console.log('[realtime]', 'connect', this.options);
      switch (this.states['push']) {
        case 'connected':
          return $.Deferred().resolve().promise();
        case 'connecting':
          return this.getPromise('push:connecting').promise();
      }

      var self = this,
          dfd = $.Deferred();

      this.getIOClient()
        .done(function (io) {
          self.setState('push', 'connecting');
          self.storePromise('push:connecting', dfd);
          self.socket = io(self.options.server, self.options);
          self.bindSocketEvents();
        })
        .fail(function () {
          self.setState('polling', 'connecting');
          self.storePromise('polling:connecting', dfd);
        })
        .always(function () {
          self.join(self.offlineContext);
          self.offlineContext = null;
        });

      return dfd.promise()
        .done(function () {
          self.trigger('connected', $.extend({ states: self.states }, options));
          self.startActivityMonitor();
        });
    },

    disconnect: function (options) {
      // console.log('[realtime] disconnect');
      if (this.getState() === 'offline')
        return $.Deferred().resolve().promise();

      if (this.states['push'] === 'disconnecting')
        return this.getPromise('push:disconnecting').promise();

      var self = this,
          dfd = $.Deferred();

      // disconnect socket
      if (this.socket && this.socket.connected) {
        this.setState('push', 'disconnecting');
        this.storePromise('push:disconnecting', dfd);
        this.socket.disconnect();
      } else {
        dfd.resolve();
      }

      this.stopPushRejoin();

      // stop polling
      this.stopPolling();

      this.offlineContext = null;

      return dfd.promise()
        .always(function () {
          self.setStates({ push: 'offline', polling: 'offline' });
          self.socket = null;
          self.rooms = [];
          self.analytics = [];
          self.promises = {};
          self.events = {};
          self.entities = {};
          self.trigger('disconnected', $.extend({ states: self.states }, options));
        });
    },

    ping: function () {
      var self = this,
          dfd = $.Deferred();

      this.socket.emit('ping', { timestamp: +(new Date()) } , function (name, data) {
        if ('pong' !== name) {
          dfd.reject();
        } else {
          self.trigger('pong', data);
          dfd.resolve(data);
        }
      });
      return dfd.promise();
    },

    /*
     * Rooms
     */
    joinFromPush: function (params) {
      // console.log('[realtime] joinFromPush', params);
      var self = this,
          dfd = $.Deferred();

      if (!this.socket) {
        dfd.reject();
      } else {
        this.socket.emit('join', $.extend({ token: this.options.apiToken }, params), function (error, rooms, headers) {
          headers = headers || {};
          if ('date' in headers)
            self.lastPullTime = self.lastPullTime || +(new Date(headers['date']));
          if (error) {
            console.log('[realtime] Unable to join rooms on the Wisembly websocket server', error, params);
            self.setState('polling', 'full');
            dfd.reject(error);
          } else {
            console.log('[realtime] Successfully joined %d rooms on the Wisembly websocket server', rooms.length, rooms);
            self.setState('polling', 'medium');
            self.rooms = rooms;
            self.trigger('rooms', { rooms: self.rooms });
            dfd.resolve(self.rooms);
          }
        });
      }
      return dfd.promise();
    },

    joinFromAPI: function (params) {
      // console.log('[realtime] joinFromAPI', params);
      var self = this,
          dfd = $.Deferred();

      this.fetchRooms({ data: JSON.stringify(params) })
        .done(function (data, status, jqXHR) {
          data = data.success || data;
          data = data.data || data;
          $.each(data.rooms, function (index, room) {
            if ($.inArray(room, self.rooms) === -1)
              self.rooms.push(room);
          });
          if (jqXHR.getResponseHeader('Date'))
            self.lastPullTime = self.lastPullTime || +(new Date(jqXHR.getResponseHeader('Date')));
          self.setState('polling', 'full');
          self.resolvePromise('polling:connecting');

          console.log('[realtime] Successfully retrieved %d rooms from Wisembly API', self.rooms.length, self.rooms);
          self.trigger('rooms', { rooms: self.rooms });
          dfd.resolve(self.rooms);
        })
        .fail(dfd.reject);
      return dfd.promise();
    },

    join: function (params) {
      // console.log('[realtime] join', params);
      var self = this,
          dfd = $.Deferred();

      switch (this.getState()) {
        case 'push:connected':
          this.joinFromPush(params)
            .done(dfd.resolve)
            .fail(function () {
              self.joinFromAPI(params)
                .done(dfd.resolve)
                .fail(dfd.reject)
                .always(function () {
                  self.startPushRejoin(0);
                });
            });
          break;
        case 'push:connecting':
          this.getPromise('push:connecting').done(function () {
            self.join(params).done(dfd.resolve).fail(dfd.reject);
          });
          break;
        case 'polling:connecting':
        case 'polling:full':
          this.joinFromAPI(params).done(dfd.resolve).fail(dfd.reject);
          break;
        default:
          this.offlineContext = $.extend({}, this.offlineContext, params);
          dfd.reject();
      }

      return dfd.promise();
    },

    leave: function (rooms) {
      // TODO
      return $.Deferred().reject().promise();
    },

    /*
     * Analytics
     */

    addAnalytics: function (namespaces) {
      // console.log('[realtime] addAnalytics', namespaces);
      namespaces = !namespaces || $.isArray(namespaces) ? namespaces : [ namespaces ];

      var self = this,
          dfd = $.Deferred();

      switch (this.getState()) {
        case 'push:connected':
          this.socket.emit('analytics:subscribe', namespaces || [], function (error, namespaces) {
            if (error) {
              dfd.reject(error);
            } else {
              console.log('[realtime] Successfully joined %d analytics rooms on the Wisembly websocket server', namespaces.length);
              self.analytics = namespaces;
              dfd.resolve(self.analytics);
            }
          });
          break;
        default:
          $.each(namespaces || [], function (index, namespace) {
            if ($.inArray(namespace, self.analytics) === -1)
              self.analytics.push(namespace);
          });
          dfd.resolve(this.analytics);

      }
      return dfd.promise();
    },

    removeAnalytics: function (namespaces) {
      // TODO
      return $.Deferred().reject().promise();
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
      var self = this;
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = setTimeout(function () {
        self.trigger('inactivity', { timeout: self.options.inactivityTimeout });
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
      var entity = eventData.data || {},
          entityClassName = entity.class_name,
          entityId = entity.id || entity.hash,
          identifier = entityClassName && entityId ? entityClassName + ':' + entityId : null,
          time = eventData.time;

      if (identifier && time) {
        this.entities[identifier] = time;
      }
    },

    checkEntity: function(eventData) {
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

    startPushRejoin: function (intervall) {
      if (this.states['push'] !== 'connected')
        return;
      // console.log('[realtime] startPushRejoin', this.states['push']);
      var self = this;
          nbAttemps = 0;
      function fnRejoinRequest(intervall) {
        var promise = self.rooms.length ? self.joinFromPush({ rooms: self.rooms }) : $.Deferred().resolve().promise();
        promise
          .done(function () {
            self.addAnalytics(self.analytics);
          })
          .fail(function () {
            if (++nbAttemps < self.options.reconnectionAttempts)
              fnRejoinIntervall(intervall + self.options.reconnectionDelay);
          });
        return promise;
      }

      function fnRejoinIntervall(intervall) {
        if (self.states['push'] !== 'connected')
          return;
        intervall = Math.min(intervall || 0, self.options.reconnectionDelayMax);
        clearTimeout(self.pushRejoinTimer);
        self.pushRejoinTimer = setTimeout(function () {
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
      var self = this;

      function fnPullRequest() {
        return self.pull().always(fnPullIntervall);
      }

      function fnPullIntervall() {
        clearTimeout(self.pullTimer);
        switch (self.states['polling']) {
          case 'full':
            self.pullTimer = setTimeout(fnPullRequest, self.options.pullInterval);
            break;
          case 'medium':
            self.pullTimer = setTimeout(fnPullRequest, self.options.pullIntervalEnhance);
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

      var self = this;

      this.pullXHR = this.fetchPullEvents();
      return this.pullXHR
        .done(function (data) {
          data = data.success || data;
          data = data.data || data;

          $.each(data.data || [], function(index, eventData) {
            if (self.handleEvent($.extend({}, eventData, { via: 'polling' })) && self.states['polling'] !== 'full')
                self.trigger('missed', eventData);
          });
          self.lastPullTime = data.since > (self.lastPullTime || 0) ? data.since : self.lastPullTime;
        })
        .always(function () {
          self.pullXHR = null;
        });
    },

    /*
     * Socket
     */

    bindSocketEvents: function() {
      var self = this;

      this.socket.on('broadcast', function () {
        self.onSocketBroadcast.apply(self, arguments);
      });

      this.socket.on('uuid', function (data) {
        console.log('[realtime] Your unique connection ID is: ' + data.uuid);
        self.onSocketUuid.apply(self, arguments);
      });

      this.socket.on('connect', function () {
        console.log('[realtime] Welcome to the Wisembly websocket server');
        self.onSocketConnect.apply(self, arguments);
      });

      this.socket.on('connect_error', function () {
        console.log('[realtime] Cannot connect to websocket server');
        self.onSocketConnectError.apply(self, arguments);
      });

      this.socket.on('disconnect', function () {
        console.log('[realtime] Disconnected from the Wisembly websocket server');
        self.onSocketDisconnect.apply(self, arguments);
      });

      this.socket.on('reconnecting', function () {
        console.log('[realtime] Reconnecting to the Wisembly websocket server');
        self.onSocketReconnecting.apply(self, arguments);
      });

      this.socket.on('reconnect', function () {
        console.log('[realtime] Reconnected to the Wisembly websocket server');
        self.onSocketReconnect.apply(self, arguments);
      });

      this.socket.on('analytics', function (data) {
        data = data || {};
        // console.log('[realtime] Analytics', data.room, data.usersCount);
        self.onSocketAnalytics.apply(self, arguments);
      });
    },

    onSocketBroadcast: function (data) {
      var data = JSON.parse(data);
      this.handleEvent($.extend({}, data, { via: 'socket' }));
    },

    onSocketConnect: function () {
      this.setStates({ push: 'connected', polling: 'medium' });
      this.resolvePromise('push:connecting');
    },

    onSocketUuid: function (data) {
      this.uuid = data.uuid;
    },

    onSocketConnectError: function () {
      this.onSocketDisconnect();
      this.resolvePromise('push:connecting');
    },

    onSocketDisconnect: function () {
      var self = this;
      this.resolvePromise('push:disconnecting')
        .fail(function () {
          self.setStates({ push: 'offline', polling: 'full' });
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
      var url = this.options.apiHost + '/' + this.options.apiNamespace + '/' + path;
      return url.replace(/([^:]\/)\//g, function ($0, $1) { return $1; });
    },

    apiRequest: function (path, options) {
      var self = this,
          token = this.options.apiToken,
          url = this.buildURL(path);
      if (!url)
        return $.Deferred().reject().promise();
      options = $.extend(true, {
          url: url,
          type: 'GET',
          dataType: 'json',
          contentType: 'application/json',
          headers: {
            'Wisembly-Token': token
          },
          cache: false
      }, options);
      return $.ajax(options)
        .fail(function (jqXHR, textStatus, errorThrown) {
          var data = { request: $.extend({ path: path, token: token }, options) };
          try { data = $.extend(data, jqXHR ? $.parseJSON(jqXHR.responseText) : {}); } catch (e) { }
          self.trigger('error', data);
        });
    },

    fetchRooms: function (options) {
      return this.apiRequest('users/node/credentials', $.extend({
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
      var self = this,
          dfd = this.getPromise(name);
      if (dfd.state() === 'pending')
        dfd.resolve();
      return dfd.promise().always(function () {
        delete self.promises[name];
      });
    },

    /*
     * State
     */

    setStates: function (states) {
      if (states['push'] === this.states['push'] && states['polling'] === this.states['polling'])
        return;
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

    setState: function (mode, state) {
      // console.log('[realtime] setState', mode, state);
      var states = {
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

    on: function (name, handler) {
      if (this.__bindings.hasOwnProperty(name))
        this.__bindings[name].push(handler);
      else
        this.__bindings[name] = [handler];
    },

    off: function (name, handler) {
      if (!this.__bindings.hasOwnProperty(name))
        return;
      var index = $.inArray(handler, this.__bindings[name]);
      if (index !== -1)
        this.__bindings[name].splice(index, 1);
    },

    trigger: function (name) {
      if (!this.__bindings.hasOwnProperty(name))
        return;

      var bindings = this.__bindings[name],
        args = Array.prototype.slice.call(arguments, 1);

      for (var i = 0; i < bindings.length; i++) {
        bindings[i].apply(null, args);
      }
    }
  };
})(jQuery);
