import fs from 'fs';
import AWS from 'aws-sdk';
import path from 'path';
import tmp from 'tmp';
import {Promise} from 'bluebird';
import {DatabaseConnector} from 'cloud-core'
import {SendmailClient, MessageUtils, TrackingUtils, ModelUtils} from 'isomorphic-core'
import CloudWorker from '../cloud-worker'

Promise.promisifyAll(fs);

const NODE_ENV = process.env.NODE_ENV || 'production'
const BUCKET_NAME = process.env.BUCKET_NAME
const AWS_ACCESS_KEY_ID = process.env.BUCKET_AWS_ACCESS_KEY_ID
const AWS_SECRET_ACCESS_KEY = process.env.BUCKET_AWS_SECRET_ACCESS_KEY

if (NODE_ENV !== 'development' &&
  (!BUCKET_NAME || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY)) {
  throw new Error("You need to define S3 access credentials.")
}

AWS.config.update({
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECRET_ACCESS_KEY })

const s3 = new AWS.S3({apiVersion: '2006-03-01'});


export default class SendLaterWorker extends CloudWorker {
  pluginId() {
    return 'send-later';
  }

  _identifyFolderRole(folderTable, role, prefix) {
    // identify the sent folder in the list of IMAP boxes node-imap returns.
    // this is a little complex because node-imap tries to
    // abstract IMAP folders – regular IMAP doesn't support recursive folders,
    // so we need to rebuild the actual name of the folder to be able to save
    // files in it. Hence, the recursive function passing a prefix around.
    for (const folderName of Object.keys(folderTable)) {
      const folder = folderTable[folderName];
      if (folder.attribs.indexOf(role) !== -1) {
        return prefix + folderName;
      }

      let recursiveResult = null;
      if (folder.children) {
        if (prefix !== '') {
          recursiveResult = this._identifyFolderRole(folder.children, role,
                                                    prefix + folderName + folder.delimiter);
        } else {
          recursiveResult = this._identifyFolderRole(folder.children, role,
                                                    folderName + folder.delimiter);
        }

        if (recursiveResult) {
          return recursiveResult;
        }
      }
    }

    return null;
  }

  identifySentFolder(folderTable) {
    return this._identifyFolderRole(folderTable, '\\Sent', '');
  }

  identifyTrashFolder(folderTable) {
    return this._identifyFolderRole(folderTable, '\\Trash', '');
  }

  async fetchLocalAttachment(accountId, objectId) {
    const uploadId = `${accountId}-${objectId}`;
    const filepath = path.join("/tmp", "uploads", uploadId);
    return fs.readFileAsync(filepath)
  }

  async deleteLocalAttachment(accountId, objectId) {
    const uploadId = `${accountId}-${objectId}`;
    const filepath = path.join("/tmp", "uploads", uploadId);
    await fs.unlinkAsync(filepath);
  }

  async fetchS3Attachment(accountId, objectId) {
    const uploadId = `${accountId}-${objectId}`;

    return new Promise((resolve, reject) => {
      s3.getObject({
        Bucket: BUCKET_NAME,
        Key: uploadId,
      }, (err, data) => {
        if (err) {
          reject(err);
        }

        const body = data.Body;
        resolve(body);
      })
    });
  }

  async deleteS3Attachment(accountId, objectId) {
    const uploadId = `${accountId}-${objectId}`;

    return new Promise((resolve, reject) => {
      s3.deleteObject({
        Bucket: BUCKET_NAME,
        Key: uploadId,
      }, (err, data) => {
        if (err) {
          reject(err);
        }

        resolve(data);
      })
    });
  }

  async sendPerRecipient({account, baseMessage, usesOpenTracking, usesLinkTracking, logger = console} = {}) {
    const recipients = [].concat(baseMessage.to, baseMessage.cc, baseMessage.bcc);
    const failedRecipients = []

    for (const recipient of recipients) {
      const customBody = TrackingUtils.addRecipientToTrackingLinks({
        recipient,
        baseMessage,
        usesOpenTracking,
        usesLinkTracking,
      })

      const individualizedMessage = ModelUtils.deepClone(baseMessage);
      individualizedMessage.body = customBody;
      // TODO we set these temporary properties which aren't stored in the
      // database model because SendmailClient requires them to send the message
      // with the correct headers.
      // This should be cleaned up
      individualizedMessage.references = baseMessage.references;
      individualizedMessage.inReplyTo = baseMessage.inReplyTo;

      try {
        const sender = new SendmailClient(account, logger);
        await sender.sendCustom(individualizedMessage, {to: [recipient]})
      } catch (error) {
        logger.error({err: error, recipient: recipient.email}, 'SendMessagePerRecipient: Failed to send to recipient');
        failedRecipients.push(recipient.email)
      }
    }
    if (failedRecipients.length === recipients.length) {
      throw new Error('SendMessagePerRecipient: Sending failed for all recipients', 500);
    }
    return {failedRecipients}
  }

  async cleanupSentMessages(account, conn, sender, logger, message) {
    await conn.connect();

    const boxes = await conn.getBoxes();

    const sentName = message.sentFolderName || this.identifySentFolder(boxes);
    const trashName = message.trashFolderName || this.identifyTrashFolder(boxes);

    const sentBox = await conn.openBox(sentName);
    logger.debug("Opened sent box", sentName);
    // Remove all existing messages.
    const uids = await sentBox.search([['HEADER', 'Message-ID', message.message_id_header]]) || []
    logger.debug("Found Gmail's optimistically placed message UIDs in sent folder", uids);
    for (const uid of uids) {
      logger.debug("Moving from sent to trash", uid);
      await sentBox.moveFromBox(uid, trashName);
    }
    await sentBox.closeBox();

    // Now, go the trash folder and remove all messages marked as deleted.
    const trashBox = await conn.openBox(trashName);
    logger.debug("Opened trash box", trashName);
    const trashUids = await trashBox.search([['HEADER', 'Message-ID', message.message_id_header]])
    logger.debug("Found message UIDs in trash", uids);
    for (const uid of trashUids) {
      logger.debug("Fully removing from trash", uid);
      await trashBox.addFlags(uid, 'DELETED')
    }
    await trashBox.closeBox({expunge: true});

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

    /**
     * When you send a message through Gmail, it automatically puts a
     * message in your sent mail folder. But for a while, the message and
     * the draft have the same ID.
     */
    if (account.provider === 'gmail') {
      logger.debug("Waiting to add sent email to sent folder");
      await sleep(5000);
    }

    // Add a single message without tracking information.
    const box = await conn.openBox(sentName);
    const rawMime = await MessageUtils.buildMime(message, {includeBcc: true});
    await box.append(rawMime, {flags: 'SEEN'});
    await box.closeBox();
  }

  async hydrateAttachments(baseMessage, accountId) {
    if (!baseMessage.uploads) {
      baseMessage.uploads = []
      return baseMessage
    }
    // We get a basic JSON message from the metadata database. We need to set
    // some fields (e.g: the `attachments` field) for it to be ready to send.
    // We call this "hydrating" it.
    const attachments = [];
    for (const upload of baseMessage.uploads) {
      const attach = {};
      attach.filename = upload.filename;

      let attachmentContents;
      if (NODE_ENV === 'development') {
        attachmentContents = await this.fetchLocalAttachment(accountId, upload.id);
      } else {
        attachmentContents = await this.fetchS3Attachment(accountId, upload.id);
      }

      // This is very cumbersome. There is a bug in the npm module we use to
      // generate MIME messages – we can't pass it the buffer we get form S3
      // because it will fail in mysterious ways 5 functions down the stack.
      // To make things more complicated, the original author of the module
      // took it offline. After wrestling with this for a couple day, I decided
      // to simply write the file to a temporary directory before attaching it.
      // It's not pretty but it does the job.
      const tmpFile = Promise.promisify(tmp.file, {multiArgs: true});
      const writeFile = Promise.promisify(fs.writeFile);

      const [filePath, , cleanupCallback] = await tmpFile();
      await writeFile(filePath, attachmentContents);
      attach.targetPath = filePath;
      attach.cleanupCallback = cleanupCallback;

      if (upload.inline) {
        attach.inline = upload.inline;
      }

      attachments.push(attach);
    }

    baseMessage.uploads = attachments;
    return baseMessage;
  }

  async cleanupAttachments(logger, baseMessage, accountId) {
    if (!baseMessage.uploads) { return }
    // Remove all attachments after sending a message.
    for (const upload of baseMessage.uploads) {
      if (NODE_ENV === 'development') {
        await this.deleteLocalAttachment(accountId, upload.id);
      } else {
        await this.deleteS3Attachment(accountId, upload.id);
      }

      if (upload.cleanupCallback) {
        await upload.cleanupCallback();
      }
    }
  }

  _buildMessageFromJSON(json = {}) {
    const baseMessage = json;
    baseMessage.date = new Date(+json.date * 1000);
    return baseMessage
  }

  async performAction({metadatum, account, connection}) {
    const db = await DatabaseConnector.forShared();

    if (Object.keys(metadatum.value || {}).length === 0) {
      throw new Error("Can't send later, no metadata value")
    }
    const logger = global.Logger.forAccount(account);
    const sender = new SendmailClient(account, logger);
    const usesOpenTracking = metadatum.value.usesOpenTracking || false;
    const usesLinkTracking = metadatum.value.usesLinkTracking || false;

    let baseMessage = this._buildMessageFromJSON(metadatum.value)
    baseMessage = await this.hydrateAttachments(baseMessage, account.id);

    await this.sendPerRecipient({
      db,
      account,
      baseMessage,
      usesOpenTracking,
      usesLinkTracking,
      logger,
    });

    await this.db.sequelize.transaction(async (t) => {
      const job = await this.db.CloudJob.findById(this.job.id, {transaction: t});
      job.status = "INPROGRESS-NOTRETRYABLE";
      await job.save({transaction: t})
    })
    logger.info("Successfully sent message");

    // Now, remove all multisend messages from the user's mailbox. We wrap this
    // block in a pokemon exception handler because we don't want to send messages
    // again if it fails.
    try {
      await this.cleanupSentMessages(account, connection, sender, logger, baseMessage);
      await this.cleanupAttachments(logger, baseMessage, account.id);
      logger.info("Successfully put delayed message in sent folder");
    } catch (err) {
      this.logger.error(`Error while trying to process metadatum ${metadatum.id}`, err);
    }
  }
}
