#!/usr/bin/env node
const program = require('commander')
const puppeteer = require('puppeteer')
const fsPath = require('fs-path')
const fs = require('fs')
const path = require('path')
const RJSON = require('relaxed-json')
const recursiveRead = require('recursive-readdir')
const { promisify } = require('util')
const Bottleneck = require('bottleneck')
const childProcess = require('child_process')

const readFile = promisify(fs.readFile)
const exec = promisify(childProcess.exec)
process.on('unhandledRejection', r => console.log(r))
const limiter = new Bottleneck(2)
const start = new Date()

program
  .option('-i, --in [path]', 'Input Folder containing Jest Snapshots')
  .option('-o, --out [path]', 'Output Folder that images will be saved to')
  .option('-a, --all', 'Run snappydoo for all snapshots, not just modified ones')
  .parse(process.argv)

let excludeList = []
let fileCreationCounter = 0

async function getandSaveScreenshot (snapshots, snapshotFileName, browser) {
  async function getMessageBuilderImage (page, message) {
    await page.goto(`https://api.slack.com/docs/messages/builder?msg=${encodeURIComponent(message)}`)
    // not sure why navigation event doesn't fire
    // await page.waitForNavigation({ waitUntil: 'load' });
    await page.waitForSelector('#message_loading_indicator', { hidden: true, timeout: 30000 })

    // https://github.com/GoogleChrome/puppeteer/issues/306#issuecomment-322929342
    async function screenshotDOMElement (selector, padding = 0) {
      const rect = await page.evaluate((selector) => {
        const element = document.querySelector(selector)
        const { x, y, width, height } = element.getBoundingClientRect()
        return { left: x, top: y, width, height, id: element.id }
      }, selector)

      return page.screenshot({
        clip: {
          x: rect.left - padding,
          y: rect.top - padding,
          width: rect.width + (padding * 2),
          height: rect.height + (padding * 2)
        }
      })
    }
    return screenshotDOMElement('#msgs_div')
  }

  const page = await browser.newPage()
  page.setViewport({ width: 1000, height: 600, deviceScaleFactor: 2 })
  let renderedImage
  try {
    renderedImage = await getMessageBuilderImage(
      page,
      JSON.stringify(snapshots[snapshotFileName])
    )
  } catch (e) {
    // retry once
    console.log(e)
    console.log(`Retrying ${snapshotFileName}`)
    renderedImage = await getMessageBuilderImage(
      page,
      JSON.stringify(snapshots[snapshotFileName])
    )
  }
  try {
    await fsPath.writeFile(snapshotFileName, renderedImage, () => {})
    fileCreationCounter += 1
    console.log(`Created ${snapshotFileName}`)
  } catch (e) {
    throw new Error(`Failed to create file: ${e}`)
  }
  await page.close()
}

async function main () {
  // load config from package.json
  let packageJSON
  try {
    packageJSON = await readFile(path.join(process.cwd(), 'package.json'))
  } catch (e) {
    console.error(
      'Cannot find package.json. Make sure you run snappydoo from the root of your project',
      e
    )
  }
  const snappydooConfig = JSON.parse(packageJSON).snappydoo
  let inputPath
  let outputPath
  if (snappydooConfig) {
    if (snappydooConfig.out) {
      outputPath = snappydooConfig.out
    }
    if (snappydooConfig.in) {
      inputPath = snappydooConfig.in
    }
    if (snappydooConfig.exclude) {
      excludeList = snappydooConfig.exclude
    }
    if (snappydooConfig.limit) {
      limiter.changeSettings(snappydooConfig.limit)
    }
  }

  // command line args take precedence over package.json
  if (program.in) {
    inputPath = program.in
  }
  if (program.out) {
    outputPath = program.out
  }

  if (!outputPath || !inputPath) {
    console.error('Error: Please specify both an output and an input path.')
    process.exit(1)
  }
  const { stdout, stderr } = await exec('git ls-files --modified --others --exclude-standard')
  if (stderr) {
    throw new Error(`Couldn't run 'git ls-files' ${stderr}`)
  }
  const modifiedFiles = stdout.split('\n')
  let snapshotFiles = await recursiveRead(path.join(process.cwd(), inputPath))
  snapshotFiles = snapshotFiles.filter(file => {
    return (
      path.extname(file) === '.snap' &&
      program.all ? true : modifiedFiles.indexOf(file.replace(`${process.cwd()}/`, '')) > -1
    )
  })
  snapshotFiles = snapshotFiles.map(file => {
    return file.replace(`${process.cwd()}/${inputPath}/`, '')
  })

  const snapshots = {}
  // extraxt individual snapshots from snapshot files
  snapshotFiles.forEach(async (file) => {
    // eslint-disable-next-line
    const match = new RegExp('(.*)\/?__snapshots__\/(.*).test\.(js|ts)\.snap').exec(file)
    if (match) {
      if (excludeList.indexOf(match[2]) > -1) {
        // if snapshot is on black list, don't process any further
        return
      }

      const snapshotsInFile = require(path.join(process.cwd(), inputPath, file))
      Object.keys(snapshotsInFile).forEach((snapshotName) => {
        const cleaned = snapshotsInFile[snapshotName]
          .replace(/Object /g, '')
          .replace(/Array /g, '')
          .replace(/\n/g, '')
        let message = JSON.parse(RJSON.transform(cleaned))
        if (!message.attachments) {
          message = { attachments: [message] }
        }

        const folderName = `${outputPath}/${match[1]}/${match[2]}`
        snapshots[`${folderName}/${snapshotName}.png`] = message
      })
    }
  })

  console.log(`Fetching ${Object.keys(snapshots).length} screenshot${Object.keys(snapshots).length === 1 ? '' : 's'} from message builder`)
  const browser = await puppeteer.launch({ headless: true })
  // for (const snapshotFileName of Object.keys(snapshots)) {
  await Promise.all(
    Object.keys(snapshots).map(async (snapshotFileName) => {
      await limiter.schedule(
        getandSaveScreenshot,
        snapshots,
        snapshotFileName,
        browser
      )
    })
  )
  await browser.close()
  console.log(`Snappydoo done in ${(new Date() - start) / 1000}s. Created ${fileCreationCounter} file${fileCreationCounter === 1 ? '' : 's'}`)
}

main()
