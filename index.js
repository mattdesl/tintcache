var Class = require('klasse');
var ImageBuffer = require('imagebuffer');
var util = require('imagetint');
var rgb2lab = require('colordiff').rgb2lab;

var detectToDataURL = null;

function isDataURLSupported(canvas) {
    if (detectToDataURL === null) {
        detectToDataURL = (typeof canvas.toDataURL === "function" || typeof canvas.toDataURLHD === "function");
    }
    return detectToDataURL;
}

function toDataURL(canvas) {
    //we've already detected and found that it doesn't work...
    if (detectToDataURL === false)
        return null;

    if (typeof canvas.toDataURLHD === "function")
        return canvas.toDataURLHD();
    else if (typeof canvas.toDataURL === "function")
        return canvas.toDataURL();
    
    //no data url support..
    detectToDataURL = false;
    return null;
}

/**
 * Creates a new TintCache with the specified Image and options (optional).
 * 
 * @class TintCache
 * @constructor
 */
var TintCache = new Class({
	
	initialize: function(source, options) {
        if (!source)
            throw new Error("no Image source specified for TintCache");
        options = options || {};

        //declare default instance members...
        this._size = options.size || TintCache.DEFAULT_SIZE;
        this._mode = null;
        this._usePixelData = null;
        this._colorizeOnly = null;

        this.canvas = null;
        this.context = null;

        //the ImageBuffer tied to the original data
        this.buffer = null;
    
        this.tintsProcessed = 0;
        this.pointer = 0;

        this.tmpLab = {l:0, a:0, b:0};

        /**
         * If rounding is enabled, the RGB components will be round to the nearest N bytes 
         * whenever a tint is requested. 
         * 
         * @property {Number} rounding
         */
        this.rounding = (options.rounding===0||options.rounding) ? options.rounding : TintCache.DEFAULT_ROUNDING;

        /**
         * The Image source tied to this cache. 
         * 
         * @property {Image} source
         * @readOnly
         */
        this.source = source;

        /**
         * A boolean indicating that the Image source is 'dirty' -- this may happen
         * after an image has completed loaded, or if its source has changed,
         * or if you are using a video element. (Which might not be such a good candidate
         * for tint caching, since it changes so frequently.)
         * 
         * When set to true, the next time a tint is requested, the cache will be cleared
         * and the source image data re-read. 
         *
         * @property {Boolean} dirty
         */
        this.dirty = true;

        /**
         * This property adjusts the fuzziness of
         * the associated tint cache. This decreases the memory usage 
         * of the tint cache, at the cost of color precision.
         *
         * Changing this property will not clear the cache; so it can be changed
         * per-frame.
         *
         * @property {Number} fuzziness
         * @default  TintCache.DEFAULT_FUZZINESS (3)
         */
        this.fuzziness = (options.fuzziness===0 || options.fuzziness) ? options.fuzziness : TintCache.DEFAULT_FUZZINESS;


        //We can optimize further by using a true hash table
        //and storing the hex code as integer. 
        //But for now a simple parallel array and indexOf will do the trick
        this.tints = new Array(this.size);
        this.descriptors = new Array(this.size); //stores objects containing ImageData, Canvas, Context, and LAB color

        //this will clear the cache (set tints to defaults)
        //and also create a new canvas if necessary
        this.mode = options.mode || TintCache.DEFAULT_MODE;
	},

    /**
     * Changes the mode of this TintCache. This will clear the cache, and so it should not be done frequently.
     * 
     * @property {TintCache.Mode} mode
     */
    mode: {
        set: function(mode) {
            if (mode !== TintCache.Mode.BEST
                    && mode !== TintCache.Mode.FASTEST
                    && mode !== TintCache.Mode.COLORIZE)
                throw new Error("TintCache.Mode must be one of BEST, FASTEST, or COLORIZE");

            this._mode = mode;
            this._usePixelData = this._mode === TintCache.Mode.BEST;
            this._colorizeOnly = this._mode === TintCache.Mode.COLORIZE;

            //if we need to create a default canvas
            if (this._usePixelData && (!this.canvas || !this.context)) {
                this.canvas = document.createElement("canvas");
                this.context = this.canvas.getContext("2d");
            } 
            //if we need to release the default canvas
            else if (!this._usePixelData) {
                this.canvas = null;
                this.context = null;
            }

            //clear the cache...
            this.clear();
        },

        get: function() {
            return this._mode;
        }
    },

    /**
     * Changes the size of this tint cache. This will cause the cache to be cleared; so it
     * should not be changed frequently.
     * 
     * @property {Number} size
     */
    size: {
        set: function(size) {
            if (size <= 0)
                throw new Error("invalid size; must be > 0");
            this._size = size;

            //first clear any current references for the GC
            this.clear();

            //now update the length... hopefully this won't throw our arrays into dictionary mode
            this.tints.length = size;
            this.descriptors.length = size;

            //now we need to clear AGAIN to set all the tint hex codes to their default high mask
            this.clear();
        },

        get: function() {
            return this._size;
        }
    },

    /**
     * A convenience method to cache the specified color; this ignores fuzziness and rounding
     * to ensure that the color is included in the cache. This might be useful when pre-populating a cache,
     * where a high fuzziness would lead to a poor gradation of colors in the cache. 
     * 
     * @param  {[type]} r [description]
     * @param  {[type]} g [description]
     * @param  {[type]} b [description]
     * @return {[type]}   [description]
     */
    cache: function(r, g, b) {
        var oldRound = this.rounding;
        var oldFuzz = this.fuzziness;
        this.fuzziness = 0;
        this.rounding = 0;
        var ret = this.tinted(r, g, b);
        this.rounding = oldRound;
        this.fuzziness = oldFuzz;
        return ret;
    },

    /**
     * Returns a tinted canvas for the image associated
     * with this TintCache. 
     * 
     * If the image width and height are zero,
     * this method will return the original image immediately. 
     * The main reason we do this is to avoid problems when you
     * try to tint-cache an image that has not yet been loaded.
     * Rendering a zero-sized canvas throws errors in Chrome, and
     * will also make the TintCache useless since the cached image 
     * data is empty.
     * 
     * @param  {[type]} r [description]
     * @param  {[type]} g [description]
     * @param  {[type]} b [description]
     * @return {[type]}   [description]
     */
    tinted: function(r, g, b, fillStyle) {
        var src = this.source;

        var width = src.width,
            height = src.height;

        if (width === 0 && height === 0)
            return src;


        var step = this.rounding;
        
        if (step > 0) {
            //round to nearest N byte
            r = Math.round(r / step) * step;
            g = Math.round(g / step) * step;
            b = Math.round(b / step) * step;    
        }

        //clamp and floor
        r = ~~Math.max(0, Math.min(255, r));
        g = ~~Math.max(0, Math.min(255, g));
        b = ~~Math.max(0, Math.min(255, b));


        var i = -1;

        var usePixelData = this._usePixelData;

        //In pixel multiply mode, we need to cache the ImageData whenever it changes
        if (usePixelData && (this.dirty || !this.buffer)) {
            var canvas = this.canvas, 
                ctx = this.context;

            canvas.width = width;
            canvas.height = height;

            //draw the image to the off-screen canvas
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(src, 0, 0);

            //get its image data
            var imageData = ctx.getImageData(0, 0, width, height);

            //get a new ImageBuffer for fast pixel ops
            this.buffer = new ImageBuffer(imageData);
        }
        //The image isn't dirty, so we might have a cached tint...
        else {
            i = this.indexOf(r, g, b); 
        }

        // debugger;

        //If the tint is dirty, we need to reset this cache of tints
        //This is done in both compositing & pixel multiply mode
        if (this.dirty) {
            this.reset();
            this.dirty = false;
        }

        var ret = i !== -1 ? this.descriptors[i] : null;

        //Couldn't find a tint by that color.
        if (!ret) {
            //check to see if we've hit our max...
            if (this.pointer > this.tints.length - 1)
                this.pointer = 0; 

            //Get the canvas at the current spot in our circular stack...
            var descriptor = this.descriptors[ this.pointer ];
            var otherBuffer = null;

            //We can re-use the Canvas !
            if (descriptor) {
                //The size doesn't match, update the descriptor
                if (descriptor.width !== width
                        || descriptor.height !== height) {
                    //We can't re-use the ImageData.. gotta grab new object
                    if ( usePixelData ) {
                        var tmpImageData = descriptor.context.createImageData(width, height);
                        descriptor.buffer = new ImageBuffer(tmpImageData);
                    }
                    descriptor.canvas.width = width;
                    descriptor.canvas.height = height;
                    descriptor.width = width;
                    descriptor.height = height;
                }

                otherBuffer = descriptor.buffer;
            }
            //We need to create a new canvas
            else {
                var dcanvas = document.createElement("canvas");
                var dcontext = dcanvas.getContext("2d");

                if (usePixelData) {
                    var dImgData = dcontext.createImageData(width, height);
                    otherBuffer = new ImageBuffer(dImgData);
                }

                dcanvas.width = width;
                dcanvas.height = height;

                descriptor = {
                    width: width,
                    height: height,
                    canvas: dcanvas,
                    context: dcontext,
                    buffer: otherBuffer,
                    image: null,
                    lab: null
                };

                //store the new canvas in the array
                this.descriptors[ this.pointer ] = descriptor;
            }

            if (usePixelData) {
                //Multiplies the input by the RGBA and places it into the output (our tint)
                ImageBuffer.multiply( this.buffer, otherBuffer, r, g, b, 255 );

                //put the image data onto the canvas
                descriptor.context.putImageData( otherBuffer.imageData, 0, 0 );
            } else {
                //if no fill style is passed, we need to convert the rgb into a string
                if (!fillStyle || round!==0) {
                    fillStyle = "rgb(" + r + ", " + g + ", " + b + ")";
                }

                //now tint the cached canvas
                util.tint( descriptor.context, src, fillStyle, 0, 0, width, height, this._colorizeOnly );
            }

            var useImage = TintCache.IMAGE_STORAGE && isDataURLSupported(descriptor.canvas);

            //Whether we should use image storage
            if (useImage) {
                if (!descriptor.image)
                    descriptor.image = new Image();
                descriptor.image.src = toDataURL( descriptor.canvas );
            }

            //clear the cached LAB color...
            descriptor.lab = null;

            this.tintsProcessed++;
            
            //Store the new tint
            this.tints[ this.pointer ] = (r << 16) | (g << 8) | b;

            //Increment the pointer for next lookup..
            this.pointer++;

            //return the newly cached canvas
            return useImage ? descriptor.image : descriptor.canvas;
        } else {
            var desc = this.descriptors[i];
            var useImage = TintCache.IMAGE_STORAGE && isDataURLSupported(desc.canvas);

            //Return the cached canvas
            return useImage ? desc.image : desc.canvas;
        }
    },

    /**
     * This softly resets the cache by simply defaulting all
     * of the hex codes to TintCache.NONE (a mask higher than anything
     * that will be added to the cache). This will not destroy descriptors
     * or their ImageData references. For that, you should
     * use clear().
     */
    reset: function() {
        for (var i=0; i<this.tints.length; i++) {
            this.tints[i] = TintCache.NONE;
        }
        this.pointer = 0;
    },

    /**
     * Returns the index of the specified tint in this cache, taking
     * fuzziness into account during the lookup process.
     * 
     * @param  {[type]} r [description]
     * @param  {[type]} g [description]
     * @param  {[type]} b [description]
     * @return {[type]}   [description]
     */
    indexOf: function(r, g, b) {
        var fuzz = this.fuzziness;

        if (fuzz === 0) {
            var hex = (r << 16) | (g << 8) | b;
            return this.tints.indexOf(hex);
        } else {
            var lab1 = rgb2lab(r, g, b, this.tmpLab);

            var shortestDiffSq = Number.MAX_VALUE;
            var shortestIndex = -1;
            var tints = this.tints,
                descriptors = this.descriptors,
                fuzzSq = fuzz * fuzz;

            for (var i=0; i<tints.length; i++) {
                var rgb = tints[i];
                if (rgb === TintCache.NONE)
                    continue;

                // this loop performs much better when we use a cached lab...
                if (descriptors[i].lab === null) {
                    //unpack the tint and determine the LAB colors...
                    var r2 = ((rgb & 0xff0000) >>> 16);
                        g2 = ((rgb & 0x00ff00) >>> 8);
                        b2 = ((rgb & 0x0000ff));

                    descriptors[i].lab = rgb2lab(r2, g2, b2);
                }

                var lab2 = descriptors[i].lab;                
                var x1 = lab1.l,
                    y1 = lab1.a,
                    z1 = lab1.b,
                    x2 = lab2.l,
                    y2 = lab2.a,
                    z2 = lab2.b;

                var dx = x2-x1,
                    dy = y2-y1,
                    dz = z2-z1;

                var diffSq = dx*dx + dy*dy + dz*dz;
                
                if (diffSq < shortestDiffSq && diffSq < fuzzSq) {
                    shortestDiffSq = diffSq;
                    shortestIndex = i;
                }
                
                // var r2 = ((rgb & 0xff0000) >>> 16);
                //     g2 = ((rgb & 0x00ff00) >>> 8);
                //     b2 = ((rgb & 0x0000ff));

                // var dr = Math.abs(r2-r),
                //     dg = Math.abs(g2-g),
                //     db = Math.abs(b2-b);

                // if ( dr < fuzz && dg < fuzz && db < fuzz) {
                //     var sum = dr+dg+db;
                //     if (sum < shortestDiffSq) {
                //         shortestDiffSq = sum;
                //         shortestIndex = i;
                //     }
                // }
            }
            return shortestIndex;
        }

        return -1;
    },

    /**
     * Removes the tint by the specified color (fuzziness is taken into account).
     * This will not clear the image data or canvas that may have been at that 
     * index in the cache, since it can be re-used later.
     *
     * @param  {[type]} r [description]
     * @param  {[type]} g [description]
     * @param  {[type]} b [description]
     * @return {[type]}   [description]
     */
    remove: function(r, g, b) {
        var i = this.indexOf(r, g, b);
        if (i === -1)
            return null;
        var old = this.descriptors[i].canvas;
        this.tints[i] = TintCache.NONE;
        return old;
    },

    /**
     * Clears the tint cache and releases any references to image data and canvases.
     * This will force subsequent calls to `tinted(r, g, b)` to re-create canvases.
     */
    clear: function() {
        for (var i=0; i<this.tints.length; i++) {
            this.tints[i] = TintCache.NONE;
            this.descriptors[i] = null;
        }
        this.pointer = 0;
    },

    destroy: function() {
        this.clear();
        this.canvas = null;
        this.context = null;
        this.buffer = null;
        this.dirty = true;
    }
});


/**
 * These are flags to indicate how to tint the sprite.
 * 
 * ```
 *     Mode.BEST
 *     Mode.FASTEST
 *     Mode.COLORIZE
 * ```
 *
 * @attribute {Object} Mode
 */
TintCache.Mode = {
    BEST: "BEST",
    FASTEST: "FASTEST",
    COLORIZE: "COLORIZE"
};

//We can't use 0 for default since that will be found as (0x000000),
//so instead we use a number that is larger than anything that will be stored
//in the tint cache.
TintCache.NONE = 0xFFFFFFFF;
TintCache.IMAGE_STORAGE = false;

TintCache.DEFAULT_ROUNDING = 8;
TintCache.DEFAULT_SIZE = 5;
TintCache.DEFAULT_FUZZINESS = 2;
TintCache.DEFAULT_MODE = TintCache.Mode.BEST;

module.exports = TintCache;