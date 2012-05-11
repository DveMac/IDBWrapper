/*
 * IDBWrapper - A cross-browser wrapper for IndexedDB
 * Copyright (c) 2011 Jens Arps
 * http://jensarps.de/
 *
 * Licensed under the MIT (X11) license

 */
/*global define,global,window,console,setTimeout,when*/
(function (name, definition, global) {
	if (typeof define === 'function') {
		define(definition);
	} else {
		global[name] = definition();
	}
}('IDBStore', function () {

	Function.prototype.bind = Function.prototype.bind || function (oThis) {
		if (typeof this !== "function") {
			// closest thing possible to the ECMAScript 5 internal IsCallable function
			throw new TypeError("Function.prototype.bind - what is trying to be bound is not callable");
		}

		var aArgs = Array.prototype.slice.call(arguments, 1),
			fToBind = this,
			FNOP = function () {},
			fBound = function () {
				return fToBind.apply(this instanceof FNOP ? this : oThis || window, aArgs.concat(Array.prototype.slice.call(arguments)));
			};

		FNOP.prototype = this.prototype;
		fBound.prototype = new FNOP();

		return fBound;
	};

	var empty = {},
		IDBStore,
		defaults = {
			dbName: 'IDB',
			storeName: 'Store',
			dbVersion: 1,
			keyPath: 'id',
			autoIncrement: true,
			onStoreReady: function () {}
		},
		consts = window.IDBTransaction || window.webkitIDBTransaction,
		cursor = window.IDBCursor || window.webkitIDBCursor;

	/** helpers **/

	function noop() {}

	function isArray(a)
	{
		return Object.prototype.toString.apply(a) === '[object Array]';
	}

	function mixin(target, source) {
		var name, s;
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

	function fixupConstants(object, constants) {
		var prop;
		for (prop in constants) {
			if (constants.hasOwnProperty(prop) && !object.hasOwnProperty(prop)) {
				object[prop] = constants[prop];
			}
		}
	}

	function log(val) {
		console.log(val);
	}

	fixupConstants(consts, {
		'READ_ONLY': 'readonly',
		'READ_WRITE': 'readwrite',
		'VERSION_CHANGE': 'versionchange'
	});

	fixupConstants(cursor, {
		'NEXT': 'next',
		'NEXT_NO_DUPLICATE': 'nextunique',
		'PREV': 'prev',
		'PREV_NO_DUPLICATE': 'prevunique'
	});

	IDBStore = (function () {

		function getStore(idbstore, mode) {
			var tran = idbstore.db.transaction([idbstore.storeName], mode);
			return tran.objectStore(idbstore.storeName);
		}

		function withOpenDb(idbstore, method) {
			var deferred = when.defer(),
				args = Array.prototype.slice.call(arguments, 2),
				func = typeof method !== 'string' ? method : function () {
					var funcMode = {
							put: consts.READ_WRITE,
							'delete': consts.READ_WRITE,
							clear: consts.READ_WRITE
						},
						store = getStore(idbstore, funcMode[method] || consts.READ_ONLY),
						req = store[method].apply(store, args);

					req.onsuccess = function (event) {
						deferred.resolve({
							result: event.target.result,
							type: event.type
						});
					};

					req.onerror = deferred.reject;

					return req;
				};

			deferred.promise.then(log, log);

			idbstore.dbOpen.then(func, log);
			return deferred.promise;
		}

		var Store = function (kwArgs, onStoreReady) {
			mixin(this, defaults);
			mixin(this, kwArgs);
			this.onStoreReady = onStoreReady || this.onStoreReady;
			this.idb = window.indexedDB || window.webkitIndexedDB || window.mozIndexedDB;
			this.dbOpen = this.openDB();
		};

		Store.prototype = {

			db: null,
			dbName: null,
			dbDescription: null,
			dbVersion: null,
			store: null,
			storeName: null,
			keyPath: null,
			autoIncrement: null,
			features: null,
			onStoreReady: null,

			openDB: function () {
				// need to check for FF10, which implements the new setVersion API
				this.newVersionAPI = !!(window.IDBFactory && window.IDBFactory.prototype.deleteDatabase);

				var features = this.features = {},
					openRequest,
					deferred = when.defer();

				features.hasAutoIncrement = !window.mozIndexedDB; // TODO: Still, really?
				features.hasGetAll = false;

				if (this.newVersionAPI) {
					this.dbVersion = parseInt(this.dbVersion, 10);
					openRequest = this.idb.open(this.dbName, this.dbVersion, this.dbDescription);
				} else {
					openRequest = this.idb.open(this.dbName, this.dbDescription);
				}

				openRequest.onerror = function (error) {
					var gotVersionErr = false;
					if (error.target.hasOwnProperty('error')) {
						gotVersionErr = error.target.error.name === "VersionError";
					} else if (error.target.hasOwnProperty('errorCode')) {
						gotVersionErr = error.target.errorCode === 12; // TODO: Use const
					}
					if (gotVersionErr) {
						this.dbVersion += 1;
						//setTimeout(this.openDB.bind(this));
					} else {
						console.error('Could not open database, error', error);
					}
					deferred.reject(error);
				}.bind(this);

				openRequest.onsuccess = function (event) {
					this.db = event.target.result;

					this.db.onversionchange = function (event) {
						event.target.close();
					};

					if (this.newVersionAPI) {
						this.getObjectStore().then(function () {
							deferred.resolve(event.target.result);
						}.bind(this), log);
					} else {
						this.checkVersion(function () {
							this.getObjectStore().then(function () {
								deferred.resolve(event.target.result);
							}.bind(this));
						}.bind(this), log);
					}
				}.bind(this);

				return deferred.promise;
			},

			enterMutationState: function () {
				var deferred = when.defer(), openRequest;
				if (this.newVersionAPI) {
					this.dbVersion += 1;
					openRequest = this.idb.open(this.dbName, this.dbVersion, this.dbDescription);
					openRequest.onupgradeneeded = deferred.resolve;
					openRequest.onsuccess = deferred.reject;
					openRequest.onerror = deferred.reject;
					openRequest.onblocked = deferred.reject;
				} else {
					this.setVersion().then(deferred.resolve, log);
				}
				return deferred.promise;
			},

	/**************
	 * versioning *
	 **************/

			checkVersion: function (callback) {
				if (this.getVersion() !== this.dbVersion) {
					this.setVersion().then(callback, log);
				} else {
					return (callback && callback());
				}
			},

			getVersion: function () {
				return this.db.version;
			},

			setVersion: function () {
				var deferred = when.defer(),
					versionRequest = this.db.setVersion(this.dbVersion);

				versionRequest.onerror = deferred.reject;
				versionRequest.onblocked = deferred.reject;
				versionRequest.onsuccess = deferred.resolve;

				return deferred.promise;
			},

	/*************************
	 * object store handling *
	 *************************/

			getObjectStore: function () {
				if (this.hasObjectStore()) {
					return this.openExistingObjectStore();
				} else {
					return this.createNewObjectStore();
				}
			},

			hasObjectStore: function () {
				return this.db.objectStoreNames.contains(this.storeName);
			},

			createNewObjectStore: function () {
				var deferred = when.defer();
				this.enterMutationState().then(function (evt) {
					this.store = this.db.createObjectStore(this.storeName, {
						keyPath: this.keyPath,
						autoIncrement: this.autoIncrement
					});
					deferred.resolve(this.store);
				}.bind(this), log);
				return deferred.promise;
			},

			openExistingObjectStore: function () {
				var deferred = when.defer(),
					emptyTransaction = this.db.transaction([this.storeName]);
				this.store = emptyTransaction.objectStore(this.storeName);
				emptyTransaction.abort();
				deferred.resolve(this.store);
				return deferred.promise;
			},

			deleteObjectStore: function () {
				var deferred = when.defer();
				this.enterMutationState().then(function (evt) {
					var success, result = evt.target.result;
					var r = result.db.deleteObjectStore(this.storeName);
					deferred.resolve();
				}.bind(this), log);
				return deferred.promise;
			},

						hasObjectStore: function () {
				return this.db.objectStoreNames.contains(this.storeName);
			},

	/*********************
	 * data manipulation *
	 *********************/

			put: function (dataObj, callback) {
				if (typeof dataObj[this.keyPath] === undefined && !this.features.hasAutoIncrement) {
					dataObj[this.keyPath] = this._getUID();
				}

				return withOpenDb(this, 'put', dataObj).then(callback || noop, log);
			},

			get: function (key, callback) {
				return withOpenDb(this, 'get', key).then(callback || noop, log);
			},

			remove: function (key, callback) {
				return withOpenDb(this, 'delete', key).then(callback || noop, log);
			},

			getAll: function (callback) {
				if (this.features.hasGetAll) {
					return withOpenDb(this, 'getAll').then(callback || noop, log);
				} else {
					return this._getAllCursor().then(callback || noop, log);;
				}
			},

			_getAllCursor: function (tr) {
				var deferred = when.defer();

				withOpenDb(this, function () {
					var tran = this.db.transaction([this.storeName]),
						all = [],
						cursor,
						store = tran.objectStore(this.storeName),
						cursorRequest = store.openCursor();

					cursorRequest.onsuccess = function (event) {
						cursor = event.target.result;
						if (cursor) {
							all.push(cursor.value);
							cursor['continue']();
						} else {
							deferred.resolve({
								type: 'success',
								result: all
							});
						}
					};

					cursorRequest.onError = deferred.reject;
				}.bind(this));

				return deferred.promise;
			},

			clear: function (callback) {
				return execute(this, 'clear').then(callback || noop, log);
			},

			_getUID: function () {
				// FF bails at times on non-numeric ids. So we take an even
				// worse approach now, using current time as id. Sigh.
				return +new Date();
			},

	/************
	 * indexing *
	 ************/

			createIndex: function (indexName, propertyName, isUnique) {
				propertyName = propertyName || indexName;

				var that = this, deferred = when.defer();

				this.enterMutationState().then(function (evt) {
					var result = evt.target.result,
						index,
						putTransaction,
						store;

					if (result.objectStore) { // transaction
						index = this.db.objectStore(this.storeName).createIndex(indexName, propertyName, {
							unique: !!isUnique
						});
					} else { // db
						putTransaction = result.transaction([that.storeName]); /* , consts.READ_WRITE */
						store = putTransaction.objectStore(that.storeName);
						index = store.createIndex(indexName, propertyName, {
							unique: !!isUnique
						});
					}
					deferred.resolve(index);
				}.bind(this));

				return deferred.promise;
			},

			getIndex: function (indexName) {
				return this.store.index(indexName);
			},

			getIndexList: function () {
				return this.store.indexNames;
			},

			hasIndex: function (indexName) {
				return this.store.indexNames.contains(indexName);
			},

			removeIndex: function (indexName) {
				var deferred = when.defer();
				this.enterMutationState().then(function (evt) {
					evt.target.result.objectStore(this.storeName).deleteIndex(indexName);
					deferred.resolve();
				}.bind(this));
				return deferred.promise;
			},

	/**********
	 * cursor *
	 **********/

			iterate: function (callback, options) {
				options = mixin({
					index: null,
					order: 'ASC',
					filterDuplicates: false,
					keyRange: null,
					writeAccess: false,
					onEnd: null,
					onError: function (error) {
						console.error('Could not open cursor.', error);
					}
				}, options || {});

				var directionType = options.order.toLowerCase() === 'desc' ? 'PREV' : 'NEXT',
					cursorTransaction = this.db.transaction([this.storeName], consts[options.writeAccess ? 'READ_WRITE' : 'READ_ONLY']),
					cursorTarget = cursorTransaction.objectStore(this.storeName),
					cursorRequest;

				if (options.filterDuplicates) {
					directionType += '_NO_DUPLICATE';
				}

				if (options.index) {
					cursorTarget = cursorTarget.index(options.index);
				}

				cursorRequest = cursorTarget.openCursor(options.keyRange, cursor[directionType]);
				cursorRequest.onerror = options.onError;
				cursorRequest.onsuccess = function (event) {
					var cursor = event.target.result;
					if (cursor) {
						callback(cursor.value, cursor, cursorTransaction);
						cursor['continue']();
					} else {
						if (options.onEnd) {
							options.onEnd();
						} else {
							callback(null, cursor, cursorTransaction);
						}
					}
				};
			}

			/* key ranges */
			// TODO: implement
		};

		return Store;

	}());

	return IDBStore;

}, this));