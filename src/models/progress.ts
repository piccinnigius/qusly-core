export interface IProgressEventData {
  bytes: number;
  size: number;
  type: 'download' | 'upload';
}

export type IProgressEvent = (info: IProgressEventData) => void;