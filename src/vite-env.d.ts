/// <reference types="vite/client" />

declare module "*?raw" {
  const content: string;
  export default content;
}

declare const __MARKIO_AI_REGION__: string;
declare const __MARKIO_MAS__: boolean;

declare module "markdown-it-task-lists";
declare module "markdown-it-mark";
