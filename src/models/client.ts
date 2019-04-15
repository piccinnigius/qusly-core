import { Writable, Readable, Stream } from 'stream';
import { Client as FtpClient, FTPResponse } from 'basic-ftp';
import {  Client as SshClient, SFTPWrapper } from 'ssh2';

import { IConfig, IProtocol, IResponse, ISizeResponse, IProgressEvent, IProgressEventData } from '.';
import { createWriteStream } from 'fs';

export class Client {
  private _protocol: IProtocol;

  private _ftpClient: FtpClient;

  private _sftpClient: SFTPWrapper;

  private _sshClient: SshClient;

  private _buffered = 0;

  private _readableStream: Readable;
  
  private _writableStream: Writable;

  public onProgress: IProgressEvent;

  public connect(config: IConfig): Promise<IResponse> {
    return new Promise(async (resolve) => {
      const { protocol } = config;
      this._protocol = protocol;

      if (protocol === 'sftp') {
        this._sshClient = new SshClient();

        const onError = (err) => {
          this._sshClient.removeListener('ready', onReady)
          this.disconnect();

          return resolve({
            success: false,
            error: {
              code: err.level,
              message: err.message,
            }
          });
        };

        const onReady = () => {
          this._sshClient.removeListener('error', onError);
          this._sshClient.sftp((err, sftp) => {
            if (err) {
              this.disconnect();
              throw err;
            }

            this._sftpClient = sftp;
            resolve({ success: true });
          });
        }
        
        this._sshClient.once('error', onError);
        this._sshClient.once('ready', onReady);
        this._sshClient.connect({ username: config.user, ...config })
      } else {
        this._ftpClient = new FtpClient();

        try {
          await this._ftpClient.access({ secure: true, ...config });
          resolve({ success: true });
        } catch(err) {
          resolve({
            success: false,
            error: {
              code: err.code,
              message: err.message,
            }
          });
        }
      }
    });
  }

  public disconnect() {
    if (this._protocol === 'sftp') {
      this._sshClient.end();
    } else {
      this._ftpClient.close();
    }
    this._protocol = null
    this._ftpClient = null;
    this._sshClient = null;
    this._sftpClient = null;
    this._buffered = 0;
    this.onProgress = null;
  }

  public getSize(remotePath: string): Promise<ISizeResponse> {
    return new Promise(async (resolve) => {
      if (this._protocol === 'sftp') {
        this._sftpClient.stat(remotePath, (err, stats) => {
          if (err) {
            return resolve({
              success: false,
              error: err.message,
            });
          }
          
          resolve({ success: true, value: stats.size })
        })
      } else {
        try {
          const size = await this._ftpClient.size(remotePath);
          resolve({ success: true, value: size });
        } catch (err) {
          resolve({
            success: false,
            error: {
              code: err.code,
              message: err.message,
            }
          });
        }
      }
    });
  }

  public download(remotePath: string, local: Writable, options?: { start?: number }): Promise<IResponse> {
    return new Promise(async (resolve) => {
      const size = await this.getSize(remotePath);
      if (!size.success) return resolve(size);

      const { start } = options;
      this._buffered = 0;
      
      if (this._protocol === 'sftp') {
        this._readableStream = this._sftpClient.createReadStream(remotePath, { start: start || 0 });

        this._readableStream.on('data', (chunk) => {
          this._buffered += chunk.length;
          this._onProgress({
            bytes: this._buffered,
            size: size.value,
            type: 'download',
          });
        });

        this._readableStream.once('error', (err) => {
          this._readableStream.destroy();
          resolve({
            success: false,
            error: {
              message: err.message
            }
          });
        });

        this._readableStream.once('close', () => {
          this._readableStream.removeAllListeners();
          this._readableStream.unpipe(local);
          local.end();
          resolve({ success: true });
        });
 
        this._readableStream.pipe(local);
      } else {
        this._writableStream = local;

        try {
          this._ftpClient.trackProgress(info => {
            this._buffered = info.bytes;

            this._onProgress({
              bytes: info.bytes,
              size: size.value,
              type: 'download'
            });
          });

          await this._ftpClient.download(this._writableStream, remotePath, start);
          this._ftpClient.trackProgress(undefined);
          this._writableStream.end();
          this._writableStream = null;

          resolve({ success: true });
        } catch (err) {
          this._ftpClient.trackProgress(undefined);
          this._writableStream.end();
          this._writableStream = null;

          resolve({
            success: false,
            error: {
              code: err.code,
              message: err.message,
            }
          });
        }
      }
    });
  }

  public upload(remotePath: string, local: Readable, options?: { start?: number, size?: number }): Promise<IResponse> {
    return new Promise(async (resolve) => {
      const { start, size } = options;

      if (this._protocol === 'sftp') {
        this._writableStream = this._sftpClient.createWriteStream(remotePath);

        this._writableStream.once('error', (err) => {
          throw err;
        })

        this._writableStream.once('finish', () => {
          console.log("Finished!");
        })

        local.pipe(this._writableStream);
      } else {
        try {
          await this._ftpClient.send(`REST ${start || 0}`);

          this._ftpClient.trackProgress(info => {
            this._buffered = info.bytes;

            this._onProgress({
              bytes: info.bytes,
              size,
              type: 'upload'
            });
          });

          await this._ftpClient.upload(local, remotePath)
          this._ftpClient.trackProgress(undefined);
          
          resolve({ success: true })
        } catch (err) {
          this._ftpClient.trackProgress(undefined);
          
          resolve({
            success: false,
            error: {
              code: err.code,
              message: err.message,
            }
          });
        }
      }
    });
  }

  public async abort(): Promise<number> { 
    if (this._protocol === 'sftp') {
      this._readableStream.emit('error', new Error('Aborted'));
    } else {
      if (this._writableStream) {
        this._ftpClient.ftp.dataSocket.unpipe(this._writableStream);
        this._writableStream.end();
        this._writableStream = null;
      }
      
      const tracker = (this._ftpClient as any).progressTracker;
      tracker.onHandle = undefined;
      tracker.reportTo(undefined);
      tracker.stop();
      this._ftpClient.trackProgress(undefined);
      (this._ftpClient.ftp as any).stopTrackingTask();
      (this._ftpClient.ftp as any).task = undefined;
      this._ftpClient.ftp.dataSocket.destroy();

      await this._ftpClient.send("ABOR", true);
    }

    return this._buffered;
  }

  private _onProgress(data: IProgressEventData) {
    if (typeof this.onProgress === 'function') {
      this.onProgress(data);
    }
  }
};