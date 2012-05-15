/*global define,global,window,console,setTimeout,when*/
(function (name, definition, global) {
	if (typeof define === 'function') {
		define(definition);
	} else {
		global[name] = definition();
	}
}('IDB', function () {

	// Utils
	// -----------

	function noop() {}

	function log(v) {
		console.log(v);
	}

	Array.isArray = Array.isArray || function (a) {
		return Object.prototype.toString.call(a) === '[object Array]';
	};

	function isFunction(obj) {
		return Object.prototype.toString.call(obj) === '[object Function]';
	}

	function getUID() {
		return +new Date();
	}

	function encode(obj) {
		return JSON.stringify(obj);
	}

	function decode(str) {
		return JSON.parse(str);
	}

	function toJson(obj) {
		return decode(encode(obj));
	}

	function forEach(array, action, scope) {
		var i, len;
		for (i = 0, len = array.length; i < len; i += 1) {
			action.call(scope, array[i]);
		}
	}

	function map(array, func, scope) {
		var result = [];
		forEach(array, function (element) {
			result.push(func.call(scope, element));
		}, scope);
		return result;
	}

	function mixin(target, source) {
		var name, s, empty = {};
		for (name in source) {
			if (source.hasOwnProperty(name)) {
				s = source[name];
				if (s !== empty[name] && s !== target[name]) {
					target[name] = s;
				}
			}
		}
		return target;
	}

	Function.prototype.bind = Function.prototype.bind || function (obj) {
		if (typeof this !== "function") {
			// closest thing possible to the ECMAScript 5 internal IsCallable function
			throw new TypeError("Function.prototype.bind - what is trying to be bound is not callable");
		}

		var args = Array.prototype.slice.call(arguments, 1),
			that = this,
			Fn = function () {},
			boundFn = function () {
				return that.apply(this instanceof Fn ? this : obj || window, args.concat(Array.prototype.slice.call(arguments)));
			};

		Fn.prototype = this.prototype;
		boundFn.prototype = new Fn();

		return boundFn;
	};

	function promise(scope, method) {
		if (arguments.length === 1) {
			method = scope;
			scope = null;
		}
		var deferred = when.defer();
		method.call(scope, deferred.resolver);
		return deferred.promise;
	}

	function enterMutationState(db) {
		return promise(function (resolver) {
			if (asyncApi.newVersionAPI) {
				var openRequest;
				db.version += 1;
				openRequest = asyncApi.indexedDB.open(db.name, db.version, db.description);
				openRequest.onupgradeneeded = resolver.resolve;
				openRequest.onsuccess = resolver.reject;
				openRequest.onerror = resolver.reject;
				openRequest.onblocked = resolver.reject;
			} else {
				db.setVersion().then(resolver.resolve, log);
			}
		});
	}

	// Async Api
	// --------

	var asyncApi = {

		indexedDB: window.indexedDB || window.webkitIndexedDB || window.mozIndexedDB,

		newVersionAPI: !!(window.IDBFactory && window.IDBFactory.prototype.deleteDatabase),

		hasAutoIncrement: !window.mozIndexedDB,

		hasGetAll: false,

		keyrange: window.IDBKeyRange || window.webkitIDBKeyRange || window.mozIDBKeyRange,

		transaction: mixin(mixin({}, window.IDBTransaction || window.webkitIDBTransaction), {
			'READ_ONLY': 'readonly',
			'READ_WRITE': 'readwrite',
			'VERSION_CHANGE': 'versionchange'
		}),

		cursor: window.IDBCursor || window.webkitIDBCursor,

		formatIDBRequest: function (request) {
			return {
				errorCode: request.errorCode,
				result: request.result,
				readyState: request.readyState
			};
		}

	};

	// Wrapper
	// ====
	var Store, Database;


	// Store Wrapper
	// ---------	

	Store = (function () {

		function Store(tran, name, opts) {
			this.name = name;
			this.transaction = tran;
			mixin(this, opts);
		}

		function action(store, method, mode, methodargs, opts) {
			
			methodargs = methodargs || [null];
			methodargs = Array.isArray(methodargs) ? methodargs : [methodargs];
			
			var opts = mixin({
				success: noop,
				error: log
			}, opts || {}), whenArgs, w;

			store.transaction(mode, function(s) {	
				when.map(methodargs, function(args) {
					return promise(this, function (resolver) {
						//log({method: method, mode: mode, args: args});
						var req = s[method].apply(s, [args]);

						req.onsuccess = function (event) {
							resolver.resolve(asyncApi.formatIDBRequest(event.target));
						};

						req.onerror = resolver.reject;
					});
				}.bind(this)).then(function (requests) {
					return requests.length === 1 ? requests[0] : requests;
				}).then(opts.success, opts.error);
			});
		}

		Store.prototype = {

			keyPath: null,

			autoIncrement: null,

			get: function (key, opts) {
				action(this, 'get', asyncApi.transaction.READ_ONLY, key, opts);
			},

			put: function (obj, opts) {
				opts = mixin({
					success: noop,
					error: log
				}, opts || {});

				action(this, 'put', asyncApi.transaction.READ_WRITE, obj, opts);
			},

			count: function (keyrange, opts) {
				if (arguments.length === 1) {
					opts = keyrange;
					keyrange = asyncApi.keyrange.lowerBound(0);
				}

				action(this, 'count', asyncApi.transaction.READ_ONLY, keyrange, opts);
			},

			destroy: function (key) {},

			clear: function (opts) {
				action(this, 'clear', asyncApi.transaction.READ_WRITE, null, opts);
			}

		};

		return Store;
	}());


	// Database Wrapper
	// ---------
	Database = (function () {

		var defaults = {
				name: 'IDB',
				version: 1,
				success: noop,
				error: log
			},
			storedefaults = {
				keyPath: 'id',
				autoIncrement: true
			};

		function open(name, version, description) {
			return promise(function (resolver) {
				var openRequest;

				if (asyncApi.newVersionAPI) {
					version = parseInt(version, 10);
					openRequest = asyncApi.indexedDB.open(name, version, description);
				} else {
					openRequest = asyncApi.indexedDB.open(name, description);
				}

				openRequest.onerror = function (error) {
					var gotVersionErr = false;
					if (error.target.hasOwnProperty('error')) {
						gotVersionErr = error.target.error.name === "VersionError";
					} else if (error.target.hasOwnProperty('errorCode')) {
						gotVersionErr = error.target.errorCode === 12; // TODO: Use const
					}
					if (gotVersionErr) {
						version += 1;
						setTimeout(function () {
							this.open.call(this, name, version, description).then(resolver.resolve, log);
						}.bind(this));
					} else {
						resolver.reject(error);
					}
	//				resolver.reject(error);
				};

				openRequest.onsuccess = function (event) {
					var opendb = event.target.result;

					opendb.onversionchange = function (event) {
						event.target.close();
					};

					resolver.resolve(opendb);
				};
			});
		}

		function openExistingObjectStore(db, name) {
			return promise(function (resolver) {
				var tran = db._db.transaction([name]),
					s = tran.objectStore(name);
				tran.abort();
				resolver.resolve(s);
			});
		}

		function createNewObjectStore(db, name, opts) {
			return promise(function (resolver) {
				enterMutationState(db).then(function (evt) {
					var s = db._db.createObjectStore(name, opts);
					resolver.resolve(s);
				}, log);
			});
		}		

		function deleteExistingObjectStore(db, name) {
			return promise(function (resolver) {
				enterMutationState(db).then(function (evt) {
					try {
						db._db.deleteObjectStore(name);
					} catch (e) {
						resolver.reject(e);
					}
					resolver.resolve();
				}, log);
			});
		}

		function Database(opts) {
			mixin(this, defaults);
			mixin(this, opts);
			open(this.name, this.version, this.description).then(function (db) {
				this._db = db;
				opts.success(this);
			}.bind(this), opts.error);
		}

		Database.prototype = {

			_db: null,

			name: null,

			description: null,

			version: null,

			close: function () {
				return (this._db && this._db.close() === undefined);
			},

			destroy: function () {
				asyncApi.indexedDB.deleteDatabase(this.name);
			},

			hasObjectStore: function (name) {
				return this.getStoreNames().contains(name);
			},

			destroyStore: function (name, callback) {
				deleteExistingObjectStore(this, name).then(callback || noop, log);
			},

			setVersion: function(version) {
				return promise(function (resolver) {
					var request = this._db.setVersion(version || this.version);
					request.onerror = resolver.reject;
					request.onblocked = resolver.reject;
					request.onsuccess = resolver.resolve;
				}.bind(this));
			},

			// getStore
			// -------
			// opens or creates a store.
			// if the supplied name already exists, the existing store is returned as the first 
			// argument of callback (in this case the opts argument is ignored), otherwise
			// a new store is created and returned via the callback.
			// @param name {string} - name of the store
			// @param opts {object} (optional) - store configuration
			// @param callback {function} (optional) - function to call when store is ready?
			// @return null
			// getStore: function (name, opts, callback) {
			// 	if (arguments.length === 2 && isFunction(opts)) {
			// 		callback = opts;
			// 		opts = {};
			// 	}
			// 	opts = mixin(mixin({}, storedefaults), opts);

			// 	promise(this, function (resolver) {

			// 	}).then(function (store) {

			// 		callback && callback(new Store(this._db, store.name, opts));

			// 		// if (asyncApi.newVersionAPI) {
			// 		// 	this.getObjectStore().then(function () {
			// 		// 		deferred.resolve(event.target.result);
			// 		// 	}.bind(this), log);
			// 		// } else {
			// 		// 	this.checkVersion(function () {
			// 		// 		this.getObjectStore().then(function () {
			// 		// 			deferred.resolve(event.target.result);
			// 		// 		}.bind(this));
			// 		// 	}.bind(this), log);
			// 		// }
			// 	}.bind(this), log);
			// },

			store: function (name, opts) {
				var ready;

				opts = mixin(mixin({}, storedefaults), opts);

				if(this[name]) {
					return this[name];
				}

				if (this.hasObjectStore(name)) {
					ready = openExistingObjectStore(this, name);
				} else {
					ready = createNewObjectStore(this, name, opts);
				}

				var tran = function (mode, callback) {
					return when(ready, function() {
						var t = this._db.transaction([name], mode),
							s = t.objectStore(name);
						callback(s);
					}.bind(this));
				}.bind(this);	

				return this[name] = new Store(tran, name, {});
			},

			getStoreNames: function () {
				return this._db.objectStoreNames;
			}

		};

		return Database;
	}());


	var Factory = (function() {
		var instantiated;

		function init() {
			return {
				getDatabaseNames: function (callback) {
					var req = asyncApi.indexedDB.getDatabaseNames();
					req.onsuccess = function (evt) {
						callback && callback(evt.target.result);
					};
				},

				use: function (name, version, callback) {
					var d = new Database({ 
						name: name, 
						version: version,
						success: callback
					});
				},

				destroyAll: function (sure, reallySure) {
					if (!(sure && reallySure)) { return; }
					this.getDatabaseNames(function (names) {
						forEach(names, function (name) {
							asyncApi.indexedDB.deleteDatabase(name);
							log('Destroyed ' + name);
						});
					});
				},

				keyRange: asyncApi.keyrange
			};
		}

		return {
			getInstance: function () {
				if (!instantiated) { instantiated = init(); }
				return instantiated;
			}
		};
	}());

	return Factory.getInstance();

}, this));