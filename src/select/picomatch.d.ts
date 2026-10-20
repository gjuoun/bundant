declare module "picomatch" {
  interface PicomatchOptions {
    dot?: boolean;
  }
  type Matcher = (input: string) => boolean;
  interface Picomatch {
    (glob: string, options?: PicomatchOptions): Matcher;
  }
  const picomatch: Picomatch;
  export default picomatch;
}
