import { type Page } from "@playwright/test";
import { type ScreenshotHelper } from "./screenshot-helper";
import { type TestDocumentationHelper, type VerificationStep } from "./test-documentation-helper";

/**
 * FlowHelper couples test documentation with screenshot capture.
 * It ensures that every documented step has a corresponding screenshot and verification checks.
 */
export class FlowHelper {
  constructor(
    private page: Page,
    private screenshots: ScreenshotHelper,
    private docHelper: TestDocumentationHelper
  ) {}

  /**
   * Records a test step:
   * 1. Adds the step to the documentation helper.
   * 2. Captures a screenshot (numbered automatically by ScreenshotHelper).
   * 3. Runs the verification checks immediately during screenshot capture (programmaticCheck).
   * 
   * @param title The human-readable title of the step (e.g. "View Files")
   * @param screenshotName The base name for the screenshot (e.g. "view-files" -> "NNN-view-files.png")
   * @param verifications Array of verification checks to run
   * @param screenshotOptions Optional overrides for screenshot capture
   */
  async step(
    title: string,
    screenshotName: string,
    verifications: VerificationStep[],
    screenshotOptions: { fullPage?: boolean } = {}
  ) {
    // 1. Determine the filename that ScreenshotHelper will use
    // We need to know the counter to generate the filename for documentation.
    // ScreenshotHelper.getCounter() returns the CURRENT counter (next one to be used).
    const counter = this.screenshots.getCounter();
    const paddedNumber = String(counter).padStart(3, "0");
    const fullScreenshotFilename = `${paddedNumber}-${screenshotName}.png`;

    // 2. Add to documentation
    this.docHelper.addStep(title, fullScreenshotFilename, verifications);

    // 3. Capture screenshot & Run Checks
    // We pass the verifications to the screenshot helper's 'programmaticCheck'
    await this.screenshots.capture(this.page, screenshotName, {
      fullPage: screenshotOptions.fullPage,
      programmaticCheck: async () => {
        for (const v of verifications) {
          console.log(`      > Verifying: ${v.description}`);
          await v.check();
        }
      },
    });
  }
}
