<script lang="ts">
  
  import {
    BarcodeFormat,
    BrowserMultiFormatReader,
    DecodeHintType,
    NotFoundException,
  } from "@zxing/library";
  import { createEventDispatcher } from "svelte";
import { get } from "$lib/http";

  const hints = new Map();
  const formats = [BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX];

  hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);

  const codeReader = new BrowserMultiFormatReader();
  console.log("ZXing code reader initialized");
  /*
    const sourceSelect = document.getElementById('sourceSelect')
    selectedDeviceId = videoInputDevices[0].deviceId
    if (videoInputDevices.length >= 1) {
    videoInputDevices.forEach((element) => {
        const sourceOption = document.createElement('option')
        sourceOption.text = element.label
        sourceOption.value = element.deviceId
        sourceSelect.appendChild(sourceOption)
    })

    sourceSelect.onchange = () => {
        selectedDeviceId = sourceSelect.value;
    };

    const sourceSelectPanel = document.getElementById('sourceSelectPanel')
    sourceSelectPanel.style.display = 'block'
    }
    */

  const dispatchEvent = createEventDispatcher();
  let result = "No scan yet";
  async function startClicked() {
    const videoInputDevices = await codeReader.listVideoInputDevices();
    const selectedDeviceId = videoInputDevices[0].deviceId;
    const scanner = new Audio("/scanner-beep.mp3");
    //scanner.play();
    codeReader.decodeFromVideoDevice(
      selectedDeviceId,
      "video",
      async (r, e) => {
        if (r) {
          const newR = r.toString();
          if (newR !== result) {
            result = newR;
            console.log(`New Result: ${result}`);
            dispatchEvent("barcode", result);
            //scanner.src = "/scanner-beep.mp3";
            //scanner.play();
            /*
  const imageSearchKey = "AIzaSyCSTJm9VL7MBNP6gfScxv7mvuAz2OFoh-Q";
            const imgSearch = `https://customsearch.googleapis.com/customsearch/v1?q=${result}&searchType=image&key=AIzaSyCSTJm9VL7MBNP6gfScxv7mvuAz2OFoh-Q&cx=b57eec92c05d54096`;
            const images = await get(imgSearch);
            console.log({images});
            imageItems = images.items;
            */
          }
        }
        if (e && !(e instanceof NotFoundException)) {
          result = e.toString();
        }
      },
    );
  }

  let imgSrc = "https://images.google.com/";
  $: if (result) {
    imgSrc = `https://images.google.com/?q=${result}`;
  }

  function resetClicked() {
    codeReader.reset();
    result = "";
  }
  function snapShot() {
    const videoElement = document.getElementById("video");
    const canvasElement = document.getElementById("snapshot");
    console.log({ videoElement, canvasElement });
    if (canvasElement && videoElement) {
      const canvas = canvasElement as HTMLCanvasElement;
      const video = videoElement as HTMLVideoElement;
      const w = video.videoWidth;
      const h = video.videoHeight;
      let outputWidth = 200;
      let outputHeight = 200;
      const aspect = w / h;
      if (aspect > 1.0) {
        outputHeight = outputHeight / aspect;
      } else {
        outputWidth = outputWidth * aspect;
      }
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      var context = canvas.getContext("2d");
      if (context) {
        console.log({ w: video.videoWidth, h: video.videoHeight });
        context.drawImage(video, 0, 0, outputWidth, outputHeight);
        //context.drawImage(video, 0, 0, 200, 200);
        var dataURL = canvas.toDataURL();
        dispatchEvent("snapshot", dataURL);
        const sound = new Audio("/shutter.mp3");
        sound.play();
      }
    }
  }

  function blur() {
    dispatchEvent("barcode", result);
  }
</script>

<input type="text" bind:value={result} on:blur={blur} />
<div>
  <!-- svelte-ignore a11y-media-has-caption -->
  <video id="video" width="200" height="200" style="border: 1px solid gray" />
  <canvas
    id="snapshot"
    width="200"
    height="200"
    style="border: 1px solid blue"
  />
</div>
<div>
  <button on:click={startClicked}>Start</button>
  <button on:click={resetClicked}>Reset</button>
  <button on:click={snapShot}>Snapshot</button>
</div>

<style>
  canvas {
    display: none;
  }
  input {
    display: none;
  }
</style>
