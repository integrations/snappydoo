const base64 = require('base-64')
const path = require('path')
const _eval = require('eval')
const RJSON = require('relaxed-json')
const puppeteer = require('puppeteer')
const Bottleneck = require('bottleneck')

const limiter = new Bottleneck(2)

function getModifiedSnapshotFiles(compareData, settings) {
  const files = compareData.files
    .filter(file => file.filename.startsWith(settings.in))
    .filter(file => path.extname(file.filename) === '.snap')
    .filter(file => {
      // Check that snapshot file is not on excluded list
      const match = new RegExp(
        '(.*)/?__snapshots__/(.*).test.(js|ts).snap'
      ).exec(file.filename)
      return (
        settings.exclude
          .map(i => i.toLowerCase())
          .indexOf(match[2].toLowerCase()) === -1
      )
    })
  return files
}

async function getScreenshot(snapshots, snapshotFileName, browser) {
  async function getMessageBuilderImage(page, message) {
    await page.goto(
      `https://api.slack.com/docs/messages/builder?msg=${encodeURIComponent(
        message
      )}`
    )
    // not sure why navigation event doesn't fire
    // await page.waitForNavigation({ waitUntil: 'load' });
    await page.waitForSelector('#message_loading_indicator', {
      hidden: true,
      timeout: 30000
    })

    // https://github.com/GoogleChrome/puppeteer/issues/306#issuecomment-322929342
    async function screenshotDOMElement(selector, padding = 0) {
      const rect = await page.evaluate(selector => {
        const element = document.querySelector(selector)
        const { x, y, width, height } = element.getBoundingClientRect()
        return { left: x, top: y, width, height, id: element.id }
      }, selector)

      return page.screenshot({
        clip: {
          x: rect.left - padding,
          y: rect.top - padding,
          width: rect.width + padding * 2,
          height: rect.height + padding * 2
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
  await page.close()
  return { snapshotFileName, renderedImage: renderedImage.toString('base64') }
}

function appHasCommittedToBranchAlready(compareData) {
  console.log(compareData.commits.length)
  for (const commit of compareData.commits) {
    if (commit.committer.id.toString() === process.env.ACTOR_ID) {
      return true
    }
  }
  return false
}

module.exports = app => {
  app.on(['pull_request.opened', 'pull_request.synchronize'], async context => {
    if (context.payload.sender.id.toString() === process.env.ACTOR_ID) {
      return
    }
    const { head, base } = context.payload.pull_request
    let compareData = (await context.github.repos.compareCommits({
      ...context.repo(),
      base: base.ref,
      head: head.ref
    })).data

    if (appHasCommittedToBranchAlready(compareData)) {
      console.log('app has commited already')
      if (
        compareData.commits.reverse()[0].committer.id.toString() ===
        process.env.ACTOR_ID
      ) {
        // latest commit is by this app, so nothing to do here
        return
      }

      // Figure out what the changes are since the last time we committed to this branch
      let newBase
      compareData.commits.reverse().forEach((commit, index) => {
        if (commit.committer.id.toString() === process.env.ACTOR_ID) {
          newBase = compareData.commits.reverse()[index - 1].sha
        }
      })

      compareData = (await context.github.repos.compareCommits({
        ...context.repo(),
        base: newBase,
        head: head.ref
      })).data
    }

    const contents = (await context.github.repos.getContent({
      ...context.repo(),
      path: 'package.json',
      ref: head.ref
    })).data
    const packageJSON = JSON.parse(base64.decode(contents.content))
    const snappydooSettings = packageJSON.snappydoo
    const modifiedSnapshotFiles = await getModifiedSnapshotFiles(
      compareData,
      snappydooSettings
    )
    console.log(modifiedSnapshotFiles)

    if (snappydooSettings.limit) {
      limiter.changeSettings(snappydooSettings.limit)
    }

    const snapshots = {}

    await Promise.all(
      modifiedSnapshotFiles.map(async file => {
        const response = await context.github.repos.getContent({
          ...context.repo(),
          path: file.filename,
          ref: head.ref
        })
        const snapshotFileContent = base64.decode(response.data.content)
        const individualSnapshotsInFile = _eval(snapshotFileContent)

        Object.keys(individualSnapshotsInFile).forEach(snapshotName => {
          const cleaned = individualSnapshotsInFile[snapshotName]
            .replace(/Object /g, '')
            .replace(/Array /g, '')
            .replace(/\n/g, '')
          let message = JSON.parse(RJSON.transform(cleaned))
          if (!message.attachments) {
            message = { attachments: [message] }
          }

          const match = new RegExp(
            '(.*)/?__snapshots__/(.*).test.(js|ts).snap'
          ).exec(file.filename)

          const relativePath = match[1].replace(snappydooSettings.in, '')
          const folderName = `${snappydooSettings.out}${relativePath}${
            match[2]
          }`
          snapshots[`${folderName}/${snapshotName}.png`] = message
        })
      })
    )
    console.log('snapshots', snapshots)

    const browser = await puppeteer.launch({ headless: true })
    const screenshots = await Promise.all(
      Object.keys(snapshots).map(async snapshotFileName =>
        limiter.schedule(getScreenshot, snapshots, snapshotFileName, browser)
      )
    )
    await browser.close()
    await Promise.all(
      screenshots.map(async screenshot => {
        console.log('path of file about to be created/updated', screenshot.snapshotFileName)
        let blobSha
        try {
          const { data } = await context.github.repos.getContent({
            ...context.repo(),
            path: screenshot.snapshotFileName,
            ref: head.ref
          })
          blobSha = data.sha
        } catch (e) {
          console.log(e)
        }
        if (blobSha) {
          return context.github.repos.updateFile({
            ...context.repo(),
            path: screenshot.snapshotFileName,
            message: `Update snappydoo image: ${screenshot.snapshotFileName}`,
            content: screenshot.renderedImage,
            sha: blobSha,
            branch: head.ref
          })
        }
        return context.github.repos.createFile({
          ...context.repo(),
          path: screenshot.snapshotFileName,
          message: `Create snappydoo image: ${screenshot.snapshotFileName}`,
          content: screenshot.renderedImage,
          branch: head.ref
        })
      })
    )
  })

  app.on('issues.opened', async context => {
    const { issue, repository } = context.payload;

    if (issue.author_association != 'OWNER') {
      return;
    }

    // If the issue title or body doesn't include "@snappydoo redo all" we abort
    if (![issue.title, issue.body].map(text => text.includes('@snappydoo redo all')).some(bool => bool)) {
      return;
    }
    console.log('TIME TO REDO all the snapshots!!!')

    const defaultBranch = await context.github.gitdata.getReference({ ...context.repo(), ref: `heads/${repository.default_branch}`})
    console.log('default branch', defaultBranch)

    const branchName = "snappydoo/redo-all-snapshots"

    let existingBranch;
    try {
      existingBranch = await context.github.gitdata.getReference({ ...context.repo(), ref: `heads/${branchName}` })
    } catch (err) {
      if (err.code != 404) {
        throw err
      }
    } finally {
      if (existingBranch) {
        console.log(`Deleting existing ${branchName} branch`)
        await context.github.gitdata.deleteReference({ ...context.repo(), ref: existingBranch.data.ref.replace("refs/", "") })
      }
    }

    await context.github.gitdata.createReference({
      ...context.repo(),
      ref: `refs/heads/${branchName}`,
      sha: defaultBranch.data.object.sha
    })

    console.log('Getting tree of all relevant files')
    const tree = await context.github.gitdata.getTree({
      ...context.repo(),
      sha: defaultBranch.data.object.sha,
      recursive: 1,
    })
    console.log(tree.data)

    // await Promise.all()

    // await context.github.repos.createFile({
    //   ...context.repo(),
    //   branch: branchName,
    // })



    await context.github.pullRequests.create({
      ...context.repo(),
      title: "Redoing all snappydoo snapshots",
      body: `As instructed in ${issue.html_url}`,
      head: branchName,
      base: repository.default_branch
    })

  })
}
