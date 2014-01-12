//require some cross-browser shimmy stuff
require('raf.js');
var domready = require('domready');

var TintCache = require('tintcache');

domready(function() {
	var width = 500,
        height = 500;


    ///// Setup some text for debugging 
    var debugText = document.createElement("span");
    debugText.style.position = "absolute";
    debugText.style.top = 5;
    debugText.style.left = 5;
    debugText.style.color = "black";
    debugText.style.zIndex = 100;
    document.body.appendChild(debugText);

    ///// Setup 2D canvas
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    document.body.appendChild(canvas);
    document.body.style.margin = "0";

    var context = canvas.getContext("2d");

    //We make sure to only start rendering and requesting cached tints
    //once the image has been fully loaded. 
    var img = new Image();
    img.onload = populateCache;
    img.src = "img/particle.png";

    //Create a new tint cache. This demo will use a large and fuzzy cache
    var tintCache = new TintCache(img, {
        size: 300,
        fuzziness: 1,
        rounding: 15,
        mode: TintCache.Mode.BEST
    });

    var numParticles = 50;
    var particles = [];
    for (var i=0; i<numParticles; i++) {
        // var colorOff = 128 + (i % 128);

        //random color
        var color = {
            r: 0,
            g: Math.floor(Math.random()*255),
            b: 0,
        };

        //random position and velocity
        particles.push({
            x: Math.random()*width, 
            y: Math.random()*height,
            vx: Math.random() * 2 - 1, 
            vy: Math.random() * 2 - 1,
            color: color
        });
    }

    var time = 0, processed = 0;

    //To ensure we have a wide range of colors, we will pre-populate it.
    //This will also avoid any intitial stuttering as the cache is being filled. 
    function populateCache() {
        for (var i=0, b=0; i<tintCache.size; i++) {
            //get the next particle
            var p = particles[i % particles.length];
            // tintCache.cache( 0, p.color.g, i%256 );
        }

        requestAnimationFrame(render);
    }

    function render() { 
        requestAnimationFrame(render);
        context.clearRect(0, 0, width, height);

        time += 0.01;

        tintCache.tintsProcessed = 0;

        var imgWidth = img.width,
            imgHeight = img.height;

        for (var i=0; i<particles.length; i++) {
            var p = particles[i];

            //fall with gravity
            p.vy += 0.01;

            //bounce off walls
            if (p.x > width || p.x < 0)
                p.vx *= -1;
            if (p.y > height || p.y < 0)
                p.vy *= -1;

            p.x += p.vx;   
            p.y += p.vy;

            var color = p.color;

            //fade the blue channel in/out a bit...
            var off = (i+1) % 4; //offset the color a bit for each particle

            color.r = Math.round((Math.sin(time * 1)/2+0.5)*255);
            color.g = Math.round((Math.sin(time * off)/2+0.5)*255);
            color.b = Math.round(((time * 0.5 * off)/2+0.5)*255);

            //here's where we request a (cached) tint of our image
            var tintedImage = tintCache.tinted(color.r, color.g, color.b);

            //then we draw it like normal
            context.drawImage(tintedImage, p.x-imgWidth/2, p.y-imgHeight/2);
        }

        if (tintCache.tintsProcessed>0)
            processed+=tintCache.tintsProcessed;

        debugText.innerHTML = "Processed: " +processed;

        //We can see how many tints are processed per frame like so:
        //With a well-sized and fuzzy cache, ideally we want zero.
        
    }


    // setTimeout(function() {
    //     particles.length = 5;
    // }, 2000);
});