
module.exports = FrameInputStream;

var MAX_LINE_LENGTH = 4096;
var LF = "\n".charCodeAt(0);

var events = require("events");
var stream = require("stream");
var util = require("util");

function FrameInputStream(source){
    
    events.EventEmitter.call(this);
    
    this._source = source;
    
    // Used to prevent re-entrant calls to _parseFrame
    this._needParseFrame = true;
    
    this._frameQueue = [];
    
    var self = this;
    
    source.on("readable", function(){
        self._parseFrame();
    });
    
    var error = processError.bind(this);
    
    source.on("end", function(){
        if(self._frame && self._frame.readingFrame){
            error(new Error("unexpected EOF"));
        }
        else{
            emptyFrameQueue.apply(self);
        }
    });
    
    source.on("error", error);
}

util.inherits(FrameInputStream, events.EventEmitter);

FrameInputStream.prototype.getSource = function(){
    return this._source;
};

FrameInputStream.prototype.readFrame = function(callback, errorCallback){
    
    if(this._frame === undefined){
        this._frame = new IncomingFrame(this, callback, errorCallback);
        this._parseFrame();
    }
    else{
        this._frameQueue.push(new IncomingFrame(this, callback, errorCallback));
    }
};

FrameInputStream.prototype.readFrames = function(callback, errorCallback){
    
    var self = this;
    
    var readFrame = function(){
        self.readFrame(onReadFrame, errorCallback);
    };
    
    var onReadFrame = function(frame){
        readFrame();
        callback(frame);
    };
    
    readFrame();
};

FrameInputStream.prototype._parseFrame = function(){
    
    if(!this._needParseFrame){
        return;
    }
    
    this._needParseFrame = false;
    
    try{
        while(this._frame && this._frame._parse.call(this._frame, this._source));
    }
    catch(exception){
        
        if(exception instanceof ParseError){
            processError.call(this, exception);
        }
        else{
            throw exception;
        }
    }
    
    this._needParseFrame = true;
};

function emptyFrameQueue(){
    
    if(this._frame){
        
        if(this._frame.errorCallback){
            this._frame.errorCallback(this._frame.readingFrame ? frame : null);
        }
        
        delete this._frame;
    }
    
    var frameQueue = this._frameQueue;
    var frameQueueLen = frameQueue.length;
    
    for(var i = 0; i < frameQueueLen; i++){
        if(frameQueue[i].errorCallback){
            frameQueue[i].errorCallback(null);
        }
    }
    
    this._frameQueue = [];
}

function processError(exception){
    emptyFrameQueue.apply(this);
    this.emit("error", exception);
}

function ParseError(message){
    this.message = message;
}

ParseError.prototype = Error.prototype;

function IncomingFrame(frameInputStream, readerCallback, errorCallback){
    
    stream.Readable.call(this);
    
    this._frameInputStream = frameInputStream;
    
    this.readerCallback = readerCallback;
    this.errorCallback = errorCallback;
    
    this.readingFrame = false;
    
    this._parse = readCommandLine;
    this.headers = {};
}

util.inherits(IncomingFrame, stream.Readable);

IncomingFrame.prototype._read = function(size){
    this._frameInputStream._parseFrame();
};

IncomingFrame.prototype.readEmptyBody = function(callback){
    
    callback = callback || function(){};
    
    var self = this;
    
    var onReadable = function(){
        var buffer = self.read();
        if(buffer !== null){
            callback(false);
            callback = function(){};
        }
    };
    
    this.once("end", function(){
        self.removeListener("readable", onReadable);
        callback(true);
    });
    
    this.once("readable", onReadable);
    
    this.read(0);
};

function readLine(source){
    
    var data = source.read();
    
    if(data === null){
        return null;
    }
    
    var dataLength = data.length;
     
    for(var i = 0; i < dataLength; i++){
        
        if(i > MAX_LINE_LENGTH){
            throw new ParseError("maximum line length exceeded (" + MAX_LINE_LENGTH + " character limit)");
        }
        
        if(data[i] === LF){
            
            source.unshift(data.slice(i + 1));
            
            return data.toString("utf-8", 0, i);
        }
    }
    
    source.unshift(data);
    
    return null;
}

function readCommandLine(source){
    
    var line = readLine(source);
    
    if(line !== null && line.length > 0){
        
        this.readingFrame = true;
        
        this.command = decode(line);
        this._parse = readHeaderFieldLine;
        
        return true;
    }
    
    return false;
}

function readHeaderFieldLine(source){
    
    var line = readLine(source);
    
    if(line !== null){
        
        if(line.length > 0){
            
            var header = line.split(":");
            
            var name = decode(header[0]);
            var value = decode(header[1]);
            
            this.headers[name] = value;
            
            return true;
        }
        else{
            
            if(this.headers["content-length"] !== undefined){
                
                var contentLength = parseInt(this.headers["content-length"], 10);
                
                this.headers["content-length"] = contentLength;
                
                this._contentLengthRemaining = contentLength;
                
                this._parse = readFixedLengthBody;
            }
            else{
                this._parse = readBody;
            }
            
            delete this.errorCallback;
            
            var self = this;
            
            process.nextTick(function(){
                self.readerCallback(self);
                delete self.readerCallback;
            });
            
            // Return false to let the frame user control the reading of the body
        }
    }
    
    return false;
}

function readBody(source){
    
    var chunk = source.read();
    
    if(chunk === null){
        return false;
    }
    
    var terminated = null;
    
    var chunkLength = chunk.length;
    for(var i = 0; i < chunkLength; i++){
        if(chunk[i] === 0){
            terminated = i;
            break;
        }
    }
    
    if(terminated === null){
        this.push(chunk);
    }
    else{
        
        source.unshift(chunk.slice(terminated + 1));
        
        this.push(chunk.slice(0, terminated));
        this.push(null);
        
        this._parse = readTrailer;
        return true;
    }
    
    return false;
}

function readFixedLengthBody(source){
    
    var chunk = source.read();
    
    if(chunk === null){
        return false;
    }
    
    var lengthRemaining = this._contentLengthRemaining;
    
    if(chunk.length < lengthRemaining){
        
        this._contentLengthRemaining -= chunk.length;
        
        this.push(chunk);
    }
    else{
        
        source.unshift(chunk.slice(lengthRemaining));
        
        this.push(chunk.slice(0, lengthRemaining));
        
        this._parse = readNullByte;
        return true;
    }
    
    return false;
}

function readNullByte(source){
    
    var nullByte = source.read(1);
    
    if(nullByte === null){
        return false;
    }
    
    if(nullByte[0] !== 0){
        throw new ParseError("expected null byte");
    }
    
    this.push(null);
    
    this._parse = readTrailer;
    return true;
}

function readTrailer(source){
    
    this.readingFrame = false;
    
    var lineFeed = source.read(1);
    
    if(lineFeed === null){
        return false;
    }
    
    if(lineFeed[0] !== LF){
        source.unshift(lineFeed);
        this._frameInputStream._frame = this._frameInputStream._frameQueue.shift();
    }
    
    return true;
}

function decode(value){
    return value.replace(/\\./gi, function(sequence){
        
        var escapeSequences = {
            "\\n": "\n",
            "\\c": ":",
            "\\\\": "\\"
        };
        
        if(escapeSequences.hasOwnProperty(sequence)){
            return escapeSequences[sequence];
        }
        else{
            throw new ParseError("undefined escape sequence");
        }
    });
}