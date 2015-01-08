(function ($) {

  window.WisemblyRealTime = function (options) {
    this.init(options);
  };

  window.WisemblyRealTime.version = '0.1.0';

  window.WisemblyRealTime.prototype = {
    init: function (options) {
      this.mode = null;

      this.states = {};
      this.state = 'offline';

      this.__bindings = {};

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
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        pullInterval: 10000,
        pullIntervalEnhance: 60000,
        forceNew: true
        //'secure': true
      };
      this.setOptions(options);
    },

    setOptions: function (options) {
      this.options = $.extend({}, this.options, options);
    },

    connect: function (io) {
      // console.log('[realTime]', 'connect', !!io, this.options);
      this.io = io || this.io;

      switch (this.getState()) {
        case 'push:connected':
          return $.Deferred().resolve().promise();
        case 'push:connecting':
          return this.getPromise('push:connecting').promise();
      }

      var self = this,
        dfd = $.Deferred(),
        mode = this.io && this.options.server ? 'push' : 'polling';

      switch (mode) {
        case 'push':
          this.setState('push', 'connecting');
          this.storePromise('push:connecting', dfd);
          this.socket = this.io(this.options.server, this.options);
          this.bindSocketEvents();
          break;
        case 'polling':
          this.setState('polling', 'connecting');
          this.storePromise('polling:connecting', dfd);
          break;
      }

      this.join(this.offlineContext);
      this.offlineContext = null;

      return dfd.promise();
    },

    disconnect: function() {
      var self = this,
        dfd = $.Deferred();

      if (this.getState() === 'offline')
        return this.getPromise('push:disconnecting').promise();

      if (this.socket) {
        this.storePromise('push:disconnecting', dfd);
        this.socket.disconnect();
      } else {
        dfd.resolve();
      }

      clearTimeout(this.pullTimer);
      this.pullTimer = null;

      this.setStates({});
      this.offlineContext = null;

      return dfd.promise()
        .always(function () {
          self.socket = null;
          self.rooms = [];
          self.analytics = [];
          self.promises = {};
        });
    },

    /*
     * Rooms
     */

    join: function (params) {
      // console.log('[realTime] join', params);
      var self = this,
        dfd = $.Deferred();

      switch (this.getState()) {
        case 'push:connected':
          // console.log('[realTime] Trying to join rooms through Wisembly websocket server');
          this.socket.emit('join', $.extend({ token: this.options.apiToken }, params), function (error, rooms) {
            if (error) {
              // console.log('[realTime] Unable to join rooms on the Wisembly websocket server', error, params);
              self.setStates({
                push: 'offline',
                polling: 'full'
              });
              self.join(params).done(dfd.resolve).fail(dfd.reject);
            } else {
              console.log('[realTime] Successfully joined %d rooms on the Wisembly websocket server', rooms.length, rooms);
              self.rooms = rooms;
              dfd.resolve(self.rooms);
            }
          });
          break;
        case 'push:connecting':
          // console.log('[realTime] Trying to join rooms while not connected yet.... waiting');
          this.getPromise('push:connecting').done(function () {
            self.join(params).done(dfd.resolve).fail(dfd.reject);
          });
          break;
        case 'polling:connecting':
        case 'polling:full':
          // console.log('[realTime] Trying to retrieve rooms through Wisembly API');
          this.fetchRooms({ data: JSON.stringify(params) })
            .done(function (data, status, jqXHR) {
              data = data.success || data;
              data = data.data || data;
              $.each(data.rooms, function (index, room) {
                if ($.inArray(room, self.rooms) === -1)
                  self.rooms.push(room);
              });
              self.setState('polling', 'full');
              self.resolvePromise('polling:connecting');
              self.lastPullTime = self.lastPullTime || +(new Date(jqXHR.getResponseHeader('Date'))) || undefined;

              console.log('[realTime] Successfully retrieved %d rooms from Wisembly API', self.rooms.length, self.rooms);
              dfd.resolve(self.rooms);
            })
            .fail(dfd.reject);
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
      // console.log('[realTime] addAnalytics', namespaces);
      namespaces = !namespaces || $.isArray(namespaces) ? namespaces : [ namespaces ];

      var self = this,
        dfd = $.Deferred();

      switch (this.getState()) {
        case 'push:connected':
          this.socket.emit('analytics:subscribe', namespaces || [], function (error, namespaces) {
            if (error) {
              dfd.reject();
            } else {
              console.log('[realTime] Successfully joined %d analytics rooms on the Wisembly websocket server', namespaces.length);
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

    removeEvents: function () {
      this.events = {};
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
      // console.log('[realTime] sendEvent:', eventData.eventName, eventData);
      this.trigger('event:received', eventData);
    },

    /*
     * Entities
     */

    addEntity: function (eventData) {
      var entity = eventData.data || {},
        entityClassName = entity.class_name || '',
        entityHash = entity.hash || '',
        identifier = entityClassName + entityHash,
        time = eventData.time;

      if (identifier && time) {
        this.entities[identifier] = time;
      }
    },

    checkEntity: function(eventData) {
      var entity = eventData.data || {},
        entityClassName = entity.class_name || '',
        entityHash = entity.hash || '',
        identifier = entityClassName + entityHash,
        time = eventData.time;

      // accept eventData if :
      // not a valid entity (no hash and no class_name) OR not a valid eventData (no milliseconds) OR entity not registered yet OR last entity update done before this event
      return !identifier || !time || !this.entities.hasOwnProperty(identifier) || time >= this.entities[identifier];
    },

    /*
     * Polling
     */

    startPolling: function () {
      // console.log('[realTime] startPolling', this.states['polling']);
      var self = this,
        timeout = null;

      switch (this.states['polling']) {
        case 'full':
          timeout = this.options.pullInterval;
          break;
        case 'medium':
          timeout = this.options.pullIntervalEnhance;
          break;
        default:
          return;
      }

      clearTimeout(this.pullTimer);
      this.pullTimer = setTimeout(function () {
        self.pull()
          .always(function () {
            self.startPolling();
          });
      }, timeout);
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

          var count = 0;
          $.each(data.data || [], function(index, eventData) {
            count += self.handleEvent($.extend({}, eventData, { via: 'polling' })) ? 1 : 0;
          });
          switch (self.getState()) {
            case 'polling:full':
              break;
            case 'push:connected':
            case 'push:connecting':
              self.setState('polling', 'medium');
              if (count)
                console.warn('[realTime] missed_push_event:' + count + ': on ' + data.data.length + ' events');
              break;
            default:
              self.setState('polling', 'full');
              break;
          }

          self.lastPullTime = data.since > (self.lastPullTime || 0) ? data.since : self.lastPullTime;
        })
        .fail(function () {
          self.setState('polling', 'medium');
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
        self.onBroadcast.apply(self, arguments);
      });

      this.socket.on('connect', function () {
        console.log('[realTime] Welcome to the Wisembly websocket server');
        self.onConnect.apply(self, arguments);
      });

      this.socket.on('connect_error', function () {
        // console.log('[realTime] Cannot connect to websocket server');
        self.onConnectError.apply(self, arguments);
      });

      this.socket.on('disconnect', function () {
        console.log('[realTime] Disconnected from the Wisembly websocket server');
        self.onDisconnect.apply(self, arguments);
      });

      this.socket.on('reconnecting', function () {
        // console.log('[realTime] Reconnecting to the Wisembly websocket server');
        self.onReconnecting.apply(self, arguments);
      });

      this.socket.on('reconnect', function () {
        // console.log('[realTime] Reconnected to the Wisembly websocket server');
        self.onReconnect.apply(self, arguments);
      });

      this.socket.on('analytics', function (data) {
        data = data || {};
        // console.log('[realTime] Analytics', data.room, data.usersCount);
        self.onAnalytics.apply(self, arguments);
      });
    },

    onBroadcast: function (data) {
      var data = JSON.parse(data);
      this.handleEvent($.extend({}, data, { via: 'socket' }));
    },

    onConnect: function () {
      this.setStates({
        push: 'connected',
        polling: 'medium'
      });
      this.resolvePromise('push:connecting');
    },

    onConnectError: function () {
      this.onDisconnect();
      this.resolvePromise('push:connecting');
    },

    onDisconnect: function () {
      var self = this;
      this.resolvePromise('push:disconnecting')
        .fail(function () {
          self.setStates({
            push: 'offline',
            polling: 'full'
          });
        });
    },

    onReconnecting: function () {
      this.setState('push', 'connecting');
    },

    onReconnect: function () {
      this.onConnect();
    },

    onAnalytics: function (data) {
      this.trigger('analytics:update', data);
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

    fetchRooms: function (options) {
      var url = this.buildURL('users/node/credentials?token=' + this.options.apiToken);
      if (!url)
        return $.Deferred().reject().promise();
      return $.ajax($.extend(true, {
        url: url,
        type: 'POST',
        dataType: 'json',
        contentType: 'application/json',
        cache: false
      }, options));
    },

    fetchPullEvents: function (options) {
      var url = this.buildURL('pull');

      if (!url || !this.rooms.length)
        return $.Deferred().reject().promise();
      return $.ajax($.extend(true, {
        url: url,
        type: 'GET',
        dataType: 'json',
        contentType: 'application/json',
        data: {
          token: this.options.apiToken,
          rooms: this.rooms,
          since: this.lastPullTime
        },
        cache: false
      }, options));
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
      if (this.state !== state) {
        // store current state
        this.state = state;
        // trigger 'state:update'
        this.trigger('state:update', { state: state });
      }

      // update polling intervall
      if (previousStates['polling'] !== this.states['polling']) {
        this.startPolling();
      }

      // join rooms
      if (this.states['push'] === 'connected' && previousStates['push'] !== this.states['push']) {
        if (this.rooms.length)
          this.join({ rooms: this.rooms });
        if (this.analytics.length)
          this.addAnalytics(this.analytics);
      }
    },

    setState: function (mode, state) {
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
