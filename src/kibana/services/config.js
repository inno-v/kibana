define(function (require) {
  var _ = require('lodash');
  var nextTick = require('utils/next_tick');
  var configFile = require('../../config');
  var notify = require('notify/notify');

  require('services/courier');

  // share doc and val cache between apps
  var doc;
  var vals = {};

  require('modules')
    .get('kibana/services')
    .constant('configFile', configFile)
    .service('config', function ($q, $rootScope, courier, kbnVersion, configFile) {
      var watchers = {};
      var unwatchers = [];

      if (!doc) {
        doc = courier.createSource('doc')
          .index(configFile.kibanaIndex)
          .type('config')
          .id(kbnVersion);
      } else {
        // clean up after previous app
        doc
          .removeAllListeners('results')
          .courier(courier);
      }

      doc.on('results', function (resp) {
        if (!resp.found) return; // init should ensure it exists
        _.forOwn(resp._source, function (val, key) {
          if (vals[key] !== val) _change(key, val);
        });
      });

      /******
       * PUBLIC API
       ******/

      function init() {
        notify.lifecycle('config init');
        var defer = $q.defer();
        doc.fetch();
        doc.on('results', function completeInit(resp) {
          // ONLY ACT IF !resp.found
          if (!resp.found) {
            doc.doIndex({});
            return;
          }

          notify.lifecycle('config init', !!resp);
          doc.removeListener('results', completeInit);
          defer.resolve();
        });
        return defer.promise;
      }

      function get(key) {
        return vals[key];
      }

      function set(key, val) {
        // sets a value in the config
        // the es doc must be updated successfully for the update to reflect in the get api.
        if (vals[key] === val) {
          var defer = $q.defer();
          defer.resolve(true);
          return defer.promise;
        }

        var update = {};
        update[key] = val;

        return doc.doUpdate(update)
          .then(function () {
            _change(key, val);
            return true;
          })
          .catch(function (err) {
            throw err;
          });
      }

      function $watch(key, onChange) {
        // probably a horrible idea
        if (!watchers[key]) watchers[key] = [];
        watchers[key].push(onChange);
        triggerWatchers(onChange, vals[key]);
        return function un$watcher() {
          _.pull(watchers[key], onChange);
        };
      }

      function $bindToScope($scope, key, opts) {
        var configWatcher = function (val) {
          if (opts && val === void 0) val = opts['default'];
          $scope[key] = val;
        };

        var first = true;
        var scopeWatcher = function (newVal) {
          if (first) return first = false;
          set(key, newVal);
        };

        // collect unwatch/listen functions and automatically
        // run them when $scope is destroyed
        var unwatchScope = $scope.$watch(key, scopeWatcher);
        var unwatchConfig = $watch(key, configWatcher);
        var unlisten = $scope.$on('$destroy', unwatch);

        unwatchers.push(unwatch);
        function unwatch() {
          unwatchScope();
          unwatchConfig();
          unlisten();
          _.pull(unwatchers, unwatch);
        }

        // return the unwatch function so users can unwatch manually
        return unwatch;
      }

      function close() {
        watchers = null;
        unwatchers.forEach(function (unwatcher) {
          unwatcher();
        });
      }

      // expose public API on the instance
      this.init = init;
      this.close = close;
      this.get = get;
      this.set = set;
      this.$bind = $bindToScope;
      this.$watch = $watch;

      /*******
       * PRIVATE API
       *******/

      function _change(key, val) {
        notify.log('config change: ' + key + ': ' + vals[key] + ' -> ' + val);
        triggerWatchers(watchers[key], val, vals[key]);
        vals[key] = val;
      }

      function triggerWatchers(fns, cur, prev) {
        if ($rootScope.$$phase) {
          // reschedule for next tick
          nextTick(triggerWatchers, fns, cur, prev);
          return;
        }

        var isArr = _.isArray(fns);
        if (!fns || (isArr && !fns.length)) return;

        $rootScope.$apply(function () {
          if (!isArr) return fns(cur, prev);

          fns.forEach(function (onChange) {
            onChange(cur, prev);
          });
        });
      }
    });
});