function Torrent(opts) {
    jstorrent.Item.apply(this, arguments)
    this.__name__ = arguments.callee.name
    this.client = opts.client || opts.parent.parent
    console.assert(this.client)
    this.hashhexlower = null
    this.hashbytes = null
    this.magnet_info = null
    // the idea behind endgame is that when we are very near to
    // torrent completion, requests made to slow peers prevent us from
    // making the same requests to peers who would actually complete
    // the requests. so in endgame mode, ignore the fact that there
    // are outstanding requests to chunks to other peers. make up to
    // (say, 3) requests to each chunk, as long as we aren't the one
    // who made the request.
    this.isEndgame = false
    this.set('bytes_sent', 0)
    this.set('bytes_received', 0)
    if (! this.get('downloaded')) {
        this.set('downloaded', 0)
    }
    if (! this.get('uploaded')) {
        this.set('uploaded', 0)
    }
    this.invalidDisk = false
    this.invalid = false;
    this.started = false; // get('state') ? 
    this.starting = false

    this.metadata = {}
    this.infodict = null
    this.infodict_buffer = null

    this.unflushedPieceDataSize = 0

    this.pieceLength = null
    this.multifile = null
    this.fileOffsets = []
    this.size = null
    this.numPieces = null
    this.numFiles = null
    // this._attributes.bitfield = null // use _attributes.bitfield for convenience for now...
    this.bitfieldFirstMissing = null // first index where a piece is missing

    this.settings = new jstorrent.TorrentSettings({torrent:this})

    // want to persist trackers too as torrent attribute...
    this.trackers = new jstorrent.Collection({torrent:this, itemClass:jstorrent.Tracker})
    this.swarm = new jstorrent.Collection({torrent:this, itemClass:jstorrent.Peer})
    this.peers = new jstorrent.PeerConnections({torrent:this, itemClass:jstorrent.PeerConnection})
    this.pieces = new jstorrent.Collection({torrent:this, itemClass:jstorrent.Piece})
    this.files = new jstorrent.Collection({torrent:this, itemClass:jstorrent.File})

    this.connectionsServingInfodict = [] // maybe use a collection class for this instead
    this.connectionsServingInfodictLimit = 3 // only request concurrently infodict from 3 peers

    this.peers.on('connect_timeout', _.bind(this.on_peer_connect_timeout,this))
    this.peers.on('error', _.bind(this.on_peer_error,this))
    this.peers.on('disconnect', _.bind(this.on_peer_disconnect,this))

    this.think_interval = null

    if (opts.url) {
        this.initializeFromWeb(opts.url, opts.callback)
    } else if (opts.id) {
        this.hashhexlower = opts.id
    } else if (opts.entry) {
        // initialize from filesystem entry!
        console.assert(opts.callback)
        this.initializeFromEntry(opts.entry, opts.callback)
    } else {
        console.error('unsupported torrent initializer', opts)
        this.invalid = true
        return
    }

    if (opts.entry || (opts.url && ! this.magnet_info)) {
        console.log('inited torrent without hash known yet!')
    } else {
        console.assert(this.hashhexlower)
        this.hashbytes = []
        for (var i=0; i<20; i++) {
            this.hashbytes.push(
                parseInt(this.hashhexlower.slice(i*2, i*2 + 2), 16)
            )
        }
        //console.log('inited torrent',this.hashhexlower)
    }
}
jstorrent.Torrent = Torrent

//Torrent.persistAttributes = ['bitfield']
Torrent.attributeSerializers = {
    bitfield: {
        serialize: function(v) {
            return v.join('')
        },
        deserialize: function(v) {
            if (! v) { return null }
            var arr = [], len = v.length
            for (var i=0; i<len; i++) {
                arr.push(parseInt(v[i]))
            }
            return arr
        }
    },
    added: {
        serialize: function(v) {
            return v.getTime()
        },
        deserialize: function(v) {
            return new Date(v)
        }
    }
}

Torrent.prototype = {
    bytesToHashhex: function(arr) {
        console.assert(arr.length == 20)
        var s = ''
        for (var i=0; i<arr.length; i++) {
            s += pad(arr[i].toString(16), '0', 2)
        }
        console.assert(s.length == 40)
        return s
    },
    addCompactPeerBuffer: function(added) {
        var numPeers = added.length/6
        for (var i=0; i<numPeers; i++) {
            idx = 6*i
            host = [added.charCodeAt( idx ),
                    added.charCodeAt( idx+1 ),
                    added.charCodeAt( idx+2 ),
                    added.charCodeAt( idx+3 )].join('.')
            port = added.charCodeAt( idx+4 ) * 256 + added.charCodeAt( idx+5 )
            peer = new jstorrent.Peer({host:host, port:port, torrent:this})
            if (! this.swarm.contains(peer)) {
                //console.log('peer buffer added new peer',host,port)
                this.swarm.add(peer)
            }
        }

    },
    initializeFromWeb: function(url, callback) {
        console.log('torrent initialize from web')

        if (url.length == 40) {
            // initialize from info infohash!
            url = 'magnet:?xt=urn:btih:' + url + '&dn=' + url

            for (var i=0; i<jstorrent.constants.publicTrackers.length; i++) {
                url = url + '&tr=' + encodeURIComponent(jstorrent.constants.publicTrackers[i])
            }
        }


        if (url.toLowerCase().match('^magnet:')) {
            // initialize torrent from a URL...
            // parse trackers
            this.magnet_info = parse_magnet(url);
            if (! this.magnet_info) {
                this.invalid = true;
                return
            }

            if (this.magnet_info.dn) {
                this.set('name', this.magnet_info.dn[0])
            }

            if (! this.magnet_info.tr) {
                this.magnet_info.tr = jstorrent.constants.publicTrackers
            }

            if (this.magnet_info.tr) {
                // initialize my trackers
                this.initializeTrackers()
            }
            this.set('url',url)
            this.hashhexlower = this.magnet_info.hashhexlower
            this.save()
            if (callback) { callback(this) }
        } else {
            var xhr = new XMLHttpRequest;
            xhr.open("GET", url, true)
            xhr.responseType = 'arraybuffer'
            var app = this.client.app
            xhr.onload = _.bind(function(evt) {
                var headers = xhr.getAllResponseHeaders()
                console.log('loaded url',url, headers)
                this.initializeFromBuffer(evt.target.response, callback)
            },this)
            xhr.onerror = function(evt) {
                console.error('unable to load torrent url',evt)
                app.notify("Unable to load Torrent. Was the URL valid? If the site requires authentication, you must download it and drag it in.")
            }
            xhr.send() // can throw exception "A network error has occured" NetworkError
        }
    },
    initializeFromBuffer: function(buffer, callback) {
        var _this = this
        function onHashResult(result) {
            var hash = result.hash
            if (hash) {
                //console.log('hashed input torrent file to',hash)
                _this.hashbytes = ui82arr(hash)
                _this.hashhexlower = _this.bytesToHashhex(_this.hashbytes).toLowerCase()
                _this.initializeTrackers()
                _this.metadataPresentInitialize()
                console.assert(_this.hashhexlower.length == 40)
                if (callback) { callback({torrent:_this}) }
            } else {
                callback({error:'hasher error'})
            }
        }
        try {
            this.metadata = bdecode(ui82str(new Uint8Array(buffer)))
        } catch(e) {
            callback({error:"Invalid torrent file"})
            return
        }
        this.infodict = this.metadata.info
        this.infodict_buffer = new Uint8Array(bencode(this.metadata.info)).buffer
        var chunkData = this.infodict_buffer
        this.client.workerthread.send( { command: 'hashChunks',
                                         chunks: [chunkData] }, onHashResult )
    },
    initializeFromEntry: function(entry, callback) {
        // should we save this as a "disk" ? no... that would be kind of silly. just read out the metadata.
        var _this = this
        var reader = new FileReader;
        reader.onload = _.bind(function(evt) {
            //console.log('read torrent data',evt)

            if (evt.target.result.byteLength == 0) {
                callback({error:"read 0 bytes"})
                return
            }

            this.initializeFromBuffer(evt.target.result, callback)

        },this)
        reader.onerror = _.bind(function(evt) {
            // TODO -- maybe cause a notification, with level
            console.error('error reading handleLaunchWithItem',evt)
            callback({error:'FileReader error'})
        },this)
        entry.file( function(file) {
            reader.readAsArrayBuffer(file)
        })
    },
    onRestore: function() {
        // called when item is loaded on app restart

/* done in initializer now
        if (this.parent) {
            this.client = this.parent.parent
        }
*/

        //this.set('complete',this.getPercentComplete()) // wont work unless metadata loaded
        if (this.get('url') && ! this.get('metadata')) {
            this.magnet_info = parse_magnet(this.get('url'))
            this.initializeTrackers()
        }

        if (this.get('state' ) == 'started') {
            this.start()
        }
    },
    getPiece: function(num) {
        var piece = this.pieces.get(num)
        if (! piece) {
            piece = new jstorrent.Piece({torrent:this, shouldPersist:false, num:num})
            this.pieces.add(piece)
        }
        return piece
    },
    getFile: function(num) {
        var file = this.files.get(num)
        if (! file) {
            file = new jstorrent.File({torrent:this, shouldPersist:false, num:num})
            this.files.add(file)
        }
        return file
    },
    getPieceSize: function(num) {
        if (num == this.numPieces - 1) {
            return this.size - this.pieceLength * num
        } else {
            return this.pieceLength
            //return this.infodict['piece length']
        }
    },
    metadataPresentInitialize: function() { // i.e. postMetadataReceived
        // call this when infodict is newly available
        this.connectionsServingInfodict = []

        this.numPieces = this.infodict.pieces.length/20
        if (! this._attributes.bitfield) {
            this._attributes.bitfield = ui82arr(new Uint8Array(this.numPieces))
        } else {
            console.assert( this._attributes.bitfield.length == this.numPieces )
        }
        this.bitfieldFirstMissing = 0 // should fix this/set this correctly, but itll fix itself
        this.pieceLength = this.infodict['piece length']

        if (this.infodict.files) {
            this.multifile = true
            this.numFiles = this.infodict.files.length
            this.size = 0
            for (var i=0; i<this.numFiles; i++) {
                this.fileOffsets.push(this.size)
                this.size += this.infodict.files[i].length
            }
        } else {
            this.fileOffsets = [0]
            this.numFiles = 1
            this.multifile = false
            this.size = this.infodict.length
        }
        this.set('name', this.infodict.name)
        this.set('size',this.size)

        this.peers.each(function(peer){
            // send new extension handshake to everybody, because now it has ut_metadata...
            peer.sendExtensionHandshake()
            peer.newStateThink() // in case we dont send them extension handshake because they dont advertise the bit
        })
        this.set('metadata',true)
        this.set('complete', this.getPercentComplete())
        this.save()
        this.saveMetadata() // trackers maybe not initialized so they arent being saved...
        this.trigger('havemetadata')
        //this.recheckData() // only do this under what conditions?
    },
    getMetadataFilename: function() {
        return this.get('name') + '.torrent'
    },
    loadMetadata: function(callback) {
        // xxx this is failing when disk is not attached!
        var _this = this
        if (this.get('metadata')) {
            if (this.infodict) {
                callback({torrent:this})
            } else {
                var storage = this.getStorage()
                if (storage) {
                    storage.entry.getFile( this.getMetadataFilename(), null, function(entry) {
                        if (entry) {
                            _this.initializeFromEntry(entry, callback)
                        } else {
                            callback({error:'file missing'})
                        }
                    }, function(err) {
                        callback({error:"Cannot load torrent - " + err.message})
                    })
                } else {
                    callback({error:'disk missing'})
                }
            }
        } else {
            callback({error:'have no metadata'})
        }
    },
    saveMetadata: function(callback) {
        var filename = this.getMetadataFilename()
        // save metadata (i.e. .torrent file) to disk
        var storage = this.getStorage()
        var _this = this
        if (! storage) {
            this.error('disk missing')
            if (callback) {
                callback({error:'disk missing'})
            }
        } else {
            storage.entry.getFile( filename, {create:true}, function(entry) {
                entry.createWriter(function(writer) {
                    writer.onwrite = function(evt) {
                        console.log('wrote torrent metadata', evt.loaded)
                        if (callback){ callback({wrote:true}) }
                    }
                    writer.onerror = function(evt) {
                        console.error('error writing torrent metadata')
                        if (callback){ callback({error:true}) }
                    }
                    var data = new Uint8Array(bencode(_this.metadata))
                    console.assert(data.length > 0)
                    writer.write(new Blob([data]))
                })
            },
                                   function(err) {
                                       console.log('saveMetadata fail -- ',err)
                                       if (callback){callback({error:err.message})}
                                   }
                                 )
        }
    },
    getDownloaded: function() {
        if (! this.has_infodict() ) { return 0 }
        var count = 0
        for (var i=0; i<this.numPieces; i++) {
            count += this._attributes.bitfield[i] * this.getPieceSize(i)
        }
        return count
    },
    getPercentComplete: function() {
        var pct = this.getDownloaded() / this.size
        return pct
    },
    pieceDoneUpdateFileComplete: function(piece) {
        // a piece is finished, so recalculate "complete" on any files
        // affected by this.

        var filesSpan = piece.getSpanningFilesInfo()
        var fileSpan, file
        for (var i=0; i<filesSpan.length; i++) {
            fileSpan = filesSpan[i]
            file = this.getFile(fileSpan.fileNum)
            file.set('downloaded',file.get('downloaded')+fileSpan.size)
            file.set('complete', file.get('downloaded') / file.size )
        }
    },
    isComplete: function() {
        return this.get('complete') == 1
    },
    maybeDropShittyConnection: function() {
        if (! this.infodict) { return }
        if (this.get('complete') == 1) { return }

        var now = new Date()
        // looks at our current connections and sees if we maybe want to disconnect from somebody.
        if (this.started) {
            if (this.swarm.items.length > this.peers.items.length) {
                var connected = _.filter( this.peers.items, function(p) { return p.get('state') == 'connected' })

                if (connected.length > this.getMaxConns() * 0.7) { // 70% of connections are connected

                    var chokers = _.filter( connected, function(p) { 
                        return (p.amChoked &&
                                now - p.connectedWhen > 10000)
                    } )

                    if (chokers.length > 0) {
                        chokers.sort( function(a,b) { return a.connectedWhen < b.connectedWhen } )
                        //console.log('closing shittiest',chokers[0])
                        chokers[0].close('shittiest connection')
                    }
                }
            }
        }
    },
    persistPieceResult: function(result) {
        var foundmissing = true
        if (result.error) {
            console.error('persist piece result',result)
            this.error('error persisting piece: ' + result.error)
        } else {
            // clean up all registered chunk requests
            result.piece.notifyPiecePersisted()
            this.pieceDoneUpdateFileComplete(result.piece)
            //console.log('persisted piece!')
            this.unflushedPieceDataSize -= result.piece.size
            //console.log('--decrement unflushedPieceDataSize', this.unflushedPieceDataSize)
            this._attributes.bitfield[result.piece.num] = 1

            // TODO -- move below into checkDone() method
            foundmissing = false
            for (var i=this.bitfieldFirstMissing; i<this._attributes.bitfield.length; i++) {
                if (this._attributes.bitfield[i] == 0) {
                    this.bitfieldFirstMissing = i
                    foundmissing = true
                    break
                }
            }
            // send HAVE message to all connected peers
            payload = new Uint8Array(4)
            var v = new DataView(payload.buffer)
            v.setUint32(0,result.piece.num)

            this.peers.each( function(peer) {
                if (peer.peerHandshake) {
                    peer.sendMessage("HAVE", [payload.buffer])
                }
            });
        }
        
        if (! foundmissing) {
            console.log('%cTORRENT DONE!','color:#0f3')
            this.set('state','complete')

            // TODO -- turn this into progress notification type
            //this.client.app.createNotification({details:"Torrent finished! " + this.get('name')})
            this.trigger('complete')

            // send everybody NOT_INTERESTED!
            this.peers.each( function(peer) {
                peer.sendMessage("NOT_INTERESTED")
            });

            app.analytics.sendEvent("Torrent", "Completed")
        }

        var dld = this.getDownloaded()
        var pct = dld / this.size
        this.set('downloaded', dld)
        this.set('complete', pct)
        this.trigger('progress')
        this.save()
    },
    notifyInvalidPiece: function(piece) {
        // when a piece comes back invalid, we delete the piece, and now need to clean up the peers too... ?
        this.peers.each( function(peerconn) {
            for (var key in peerconn.pieceChunkRequests) {
                if (key.split('/')[0] == piece.num) {
                    // TODO -- make more accurate
                    peerconn.close('contributed to invalid piece')
                    break
                }
            }
        })
    },
    checkPieceChunkTimeouts: function(pieceNum, chunkNums) {
        // XXX this timeout will get called even if this torrent was removed and its data .reset()'d
        //console.log('checkPieceChunkTimeouts',pieceNum,chunkNums)
        if (this._attributes.bitfield[pieceNum]) { return }
        if (this.pieces.containsKey(pieceNum)) {
            this.getPiece(pieceNum).checkChunkTimeouts(chunkNums)
        }
    },
    persistPiece: function(piece) {
        // saves this piece to disk, and update our bitfield.
        var storage = this.getStorage()
        if (storage) {
            storage.diskio.writePiece(piece, _.bind(this.persistPieceResult,this))
        } else {
            this.error('Storage missing')
        }
    },
    getStorage: function() {
        var disk = this.get('disk')
        if (! disk) {
            var disk = this.client.disks.getAttribute('default')
        }

        var storage = this.client.disks.get(disk)
        if (storage) { 
            if (! this.get('disk')) {
                this.set('disk',storage.get_key())
                this.save()
            }
            return storage
        }
    },
    printComplete: function() {
        return this._attributes.bitfield.join('')
    },
    resetState: function() {
        console.log('reset torrent state')
        if (this.started) { return }
        // resets torrent to 0% and, if unable to load metadata, clears that, too.
        //this.stop()
        this.bitfieldFirstMissing = 0
        this.isEndgame = false
        var url = this.get('url')
        if (url) {
            this.unset('metadata')
            this.unset('bitfield')
            this.unset('disk')
            this.unset('complete')
            this.initializeFromWeb(url)
            //this.initializeTrackers() // trackers are missing now :-(

        } else {
            // unsupported...
            debugger
        }

    },
    recheckData: function() {
        // checks registered or default torrent download location for
        // torrent data
        // this.set('complete',0)

        // XXX this needs to clear pieces when done hashing them.
        // XXX this should not read more quickly than it can hash...

        console.log('Re-check data')
        return // too buggy
        if (this.started) {
            this.error('cannot check while started')
            return
        }
        this.set('state','checking')
        if (this.get('metadata')) {
            this.loadMetadata( _.bind(function(result) {

                var results = {}
                var resultsCollected = {num:0, total:this.numPieces}
                console.assert(this.numPieces)
                function recordResult(i,result) {
                    console.log('record result', resultsCollected, i,result)
                    results[i] = [result,'fuckme']
                    resultsCollected.num++
                    if (resultsCollected.num == resultsCollected.total) {
                        console.log('done checking',results)
                        debugger
                    }
                }


                if (result.error) {
                    this.error('no metadata')
                } else {
                    _.range(0,this.numPieces).forEach( _.bind(function(i) {

                        var piece
                        // this is a horribly fucked nightmare mess

                        if (this._attributes.bitfield[i]) {
                            piece = this.getPiece(i)
                            piece.getData(undefined, undefined, function(pieceDataResult) {
                                if (pieceDataResult.error) {
                                    recordResult(i,false)
                                } else {
                                    var s = 0

                                    for (var i=0; i<pieceDataResult.length; i++) {
                                        s += pieceDataResult[i].byteLength
                                    }

                                    if (piece.size != s) {
                                        console.error('sizes dont add up bro!',s,'should be',piece.size)
                                        recordResult(i,false)
                                    } else {
                                        piece.checkPieceHashMatch(pieceDataResult, _.bind(function(i,matched) {
                                            if (matched) {
                                                recordResult(i, true)
                                            } else {
                                                recordResult(i, false)
                                            }
                                        },this,i))
                                    }
                                }
                            })
                        } else {
                            resultsCollected.num++
                            console.log('0 bitmask',i,'increment collected',resultsCollected.num)
                        }
                    },this) )
                }
            },this))
        } else {
            console.error('cannot re-check, dont have metadata')
        }
    },
    on_peer_connect_timeout: function(peer) {
        // TODO -- fix this up so it doesn't get triggered unneccesarily
        //console.log('peer connect timeout...')
        if (!this.peers.contains(peer)) {
            //console.warn('peer wasnt in list')
        } else {
            this.peers.remove(peer)
        }
    },
    initializeFiles: function() {
        // TODO -- this blocks the UI cuz it requires so much
        // computation. split it into several computation steps...
        if (this.infodict) {

            for (var i=0; i<this.numFiles; i++) {
                if (! this.files.containsKey(i)) {
                    file = this.getFile(i)
                }
            }

        }
    },
    registerPieceRequested: function(peerconn, pieceNum, offset, size) {
        // first off, can this torrent even handle doing more disk i/o right now?
        // if so...
        var piece = this.getPiece(pieceNum)
        piece.getData(offset, size, function(result) {
            // what if peer disconnects before we even get around to starting this disk i/o job?
            // dont want to waste cycles reading...
            var header = new Uint8Array(8)
            var v = new DataView(header.buffer)
            v.setUint32(0, pieceNum)
            v.setUint32(4, offset)
            peerconn.sendMessage('PIECE', [header.buffer].concat(result))
        })
    },
    has_infodict: function() {
        return this.infodict ? true : false
    },
    error: function(msg, detail) {
        this.stop()
        this.trigger('error',msg,detail)
        this.set('state','error')
        this.lasterror = msg
        console.error('torrent error:',[msg,detail])

        if (msg == 'read 0 bytes') {
            this.client.app.onClientError(msg, 'Torrent file invalid. Click "Reset state" from the "More Actions" toolbar.')
/*
        } else if (msg == 'Disk Missing') {
            this.client.app.createNotification({details:'The disk this torrent was saving to cannot be found. Either "reset" this torrent (More Actions in the toolbar) or re-insert the disk'})
*/
        } else {
            if (this.client.disks.items.length == 0) {
            // need a more generic error...
                this.client.app.notifyNeedDownloadDirectory()
            } else {
                this.client.app.notifyStorageError()
            }
        }
        this.started = false
        this.starting = false
        this.save()
    },
    on_peer_error: function(peer) {
        //console.log('on_peer error')
        if (!this.peers.contains(peer)) {
            //console.warn('peer wasnt in list')
        } else {
            this.peers.remove(peer)
            this.set('numpeers',this.peers.items.length)
        }
    },
    on_peer_disconnect: function(peer) {
        // called by .close()
        // later onWrites may call on_peer_error, also
        //console.log('peer disconnect...')

        // XXX - for some reason .close() on the peer is not triggering this?

        if (!this.peers.contains(peer)) {
            //console.warn('peer wasnt in list')
        } else {
            this.peers.remove(peer)
            this.set('numpeers',this.peers.items.length)
        }
    },
    initializeTrackers: function() {
        var url, tracker
        var announce_list = [], urls = []
        if (this.magnet_info && this.magnet_info.tr) {
            for (var i=0; i<this.magnet_info.tr.length; i++) {
                url = this.magnet_info.tr[i];
                if (url.toLowerCase().match('^udp')) {
                    tracker = new jstorrent.UDPTracker( {url:url, torrent: this} )
                } else {
                    tracker = new jstorrent.HTTPTracker( {url:url, torrent: this} )
                }
                announce_list.push( url )
                if (! this.trackers.contains(tracker)) {
                    this.trackers.add( tracker )
                }
            }
            // trackers are stored in "tiers", whatever. magnet links
            // dont support that. put all in first tier.
            this.metadata['announce-list'] = [announce_list]
        } else {

            if (this.metadata) {
                if (this.metadata.announce) {
                    url = this.metadata.announce
                    urls.push(url)
                } else if (this.metadata['announce-list']) {
                    for (var tier in this.metadata['announce-list']) {
                        for (var i=0; i<this.metadata['announce-list'][tier].length; i++) {
                            urls.push( this.metadata['announce-list'][tier][i] )
                        }
                    }
                }

                for (var i=0; i<urls.length; i++) {
                    url = urls[i]
                    if (url.toLowerCase().match('^udp')) {
                        tracker = new jstorrent.UDPTracker( {url:url, torrent: this} )
                    } else {
                        tracker = new jstorrent.HTTPTracker( {url:url, torrent: this} )
                    }
                    this.trackers.add( tracker )
                }
            }
        }
    },
    start: function() {
        if (this.started || this.starting) { return }
        app.analytics.sendEvent("Torrent", "Starting")

        this.starting = true
        this.think_interval = setInterval( _.bind(this.newStateThink, this), 1000 )
        if (! this.getStorage()) {
            this.error('Disk Missing')
            return
        }

        if (this.get('metadata')) {
            this.loadMetadata( _.bind(function(result) {
                if (result.error) {
                    this.error(result.error)
                } else {
                    this.readyToStart()
                }
            },this))
        } else {
            this.readyToStart()
        }
    },
    readyToStart: function() {
        this.set('state','started')
        this.set('complete', this.getPercentComplete())
        this.started = true
        this.starting = false
        this.save()

        // todo // check if should re-announce, etc etc
        //this.trackers.get_at(4).announce(); 
        //return;

        if (jstorrent.options.always_add_special_peer) {
            var host = jstorrent.options.always_add_special_peer
            var peer = new jstorrent.Peer({torrent: this, host:host.split(':')[0], port:parseInt(host.split(':')[1])})
            if (! this.swarm.contains(peer)) {
                this.swarm.add(peer)
            }
        }

        setTimeout( _.bind(function(){
            // HACK delay this a little so manual peers kick in first, before frame
            if (! jstorrent.options.disable_trackers) {
                for (var i=0; i<this.trackers.length; i++) {
                    this.trackers.get_at(i).announce()
                }
            }
        },this), 1000)
        if (jstorrent.options.manual_peer_connect_on_start) {
            var hosts = jstorrent.options.manual_peer_connect_on_start[this.hashhexlower]
            if (hosts) {
                for (var i=0; i<hosts.length; i++) {
                    var host = hosts[i]
                    var peer = new jstorrent.Peer({torrent: this, host:host.split(':')[0], port:parseInt(host.split(':')[1])})
                    this.swarm.add(peer)
                }
            }
        }
        this.trigger('start')
        this.newStateThink()
    },
    maybePropagatePEX: function(data) {
        return
        this.peers.each( function(peer) {
            if (peer.peer.host == '127.0.0.1') {
                // definitely send it
                peer.sendPEX(data)
            }
        })
    },
    stop: function() {
        if (this.get('state') == 'stopped') { return }
        app.analytics.sendEvent("Torrent", "Stopping")
        this.starting = false
        this.set('state','stopped')
        this.started = false

        if (this.think_interval) { 
            clearInterval(this.think_interval)
            this.think_interval = null
        }
        // prevent newStateThink from reconnecting us

        this.peers.each( function(peer) {
            // this is not closing all the connections because it modifies .items...
            // need to iterate better...
            peer.close('torrent stopped')
        })

        for (var i=0; i<this.pieces.items.length; i++) {
            this.pieces.items[i].resetData()
        }
        // TODO -- move these into some kind of resetState function?


        // TODO - stop all disk i/o jobs for this torrent...
        if (this.getStorage()) {
            this.getStorage().cancelTorrentJobs(this)
        }

        this.pieces.clear()
        this.unflushedPieceDataSize = 0
        this.trigger('stop')
        this.save()
    },
    remove: function() {
        this.stop()
        this.set('state','removing')

        // maybe do some other async stuff? clean socket shutdown? what?
        setTimeout( _.bind(function(){
            this.set('state','stopped')
            this.save() // TODO -- clear the entry from storage? nah, just put it in a trash bin
            this.client.torrents.remove(this)
        },this), 200)
    },
    newStateThink: function() {
        /* 

           how does piece requesting work? good question...  each peer
           connection calls newStateThink() whenever some state
           changes.

           the trouble is, it makes sense to store information
           regarding requests for piece chunks on the piece
           object. however, the piece object itself has requests to a
           set of peer connections.

           when a peer disconnects, we need to update the state for
           each piece that has data registered for that peer..

           when a piece is complete, we need to notify each peer
           connection that we no longer need their data.

           so really i should think about all the different use cases
           that need to be satisfied and then determine where it makes
           most sense to store the states.

           hmmm.

        */


        /*

          it seems there are three main cases

          - peer disconnect
          - peer chokes us (more nuanced)
          - piece completed

         */

        if (! this.started) { return }
        //console.log('torrent frame!')
        if (! this.isEndgame && this.get('complete') > 0.97) { 
            this.isEndgame = true
            console.log("ENDGAME ON")
        }

        this.maybeDropShittyConnection()

        var idx, peer, peerconn
        if (this.should_add_peers() && this.swarm.length > 0) {
            idx = Math.floor( Math.random() * this.swarm.length )
            peer = this.swarm.get_at(idx)
            peerconn = new jstorrent.PeerConnection({peer:peer})
            //console.log('should add peer!', idx, peer)
            if (! this.peers.contains(peerconn)) {
                if (peer.get('only_connect_once')) { return }
                this.peers.add( peerconn )
                this.set('numpeers',this.peers.items.length)
                peerconn.connect()
            }
            // peer.set('only_connect_once',true) // huh?
        }
    },
    getMaxConns: function() {
        return this.get('maxconns') || this.client.app.options.get('maxconns')
    },
    should_add_peers: function() {
        if (this.started) {
            if (this.isComplete()) {
                return false // TODO -- how to seed?
            }

            var maxconns = this.getMaxConns()
            if (this.peers.length < maxconns) {
                return true
            }
        }
    },
    get_key: function() {
        return this.hashhexlower
    }
}

for (var method in jstorrent.Item.prototype) {
    jstorrent.Torrent.prototype[method] = jstorrent.Item.prototype[method]
}
