import * as fs from "fs";
import * as path from "path";

interface VerificationStep {
  description: string;
  check: () => Promise<void> | void;
}

interface TestStep {
  title: string;
  screenshotFile: string;
  verifications: VerificationStep[];
}

export class TestDocumentationHelper {
  private title: string = "";
  private userStory: string = "";
  private steps: TestStep[] = [];
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  setMetadata(title: string, userStory: string) {
    this.title = title;
    this.userStory = userStory;
  }

  addStep(
    title: string,
    screenshotFile: string,
    verifications: VerificationStep[]
  ) {
    this.steps.push({
      title,
      screenshotFile,
      verifications,
    });
  }

  async runStep(
    stepIndex: number,
    runChecks: boolean = true
  ): Promise<void> {
    const step = this.steps[stepIndex];
    if (!step) {
      throw new Error(`Step index ${stepIndex} out of bounds`);
    }

    console.log(`\n📖 STEP ${stepIndex + 1}: ${step.title}`);

    if (runChecks) {
      for (const verification of step.verifications) {
        console.log(`   Running check: ${verification.description}`);
        await verification.check();
        console.log(`   ✓ Passed`);
      }
    }
  }

  generateMarkdown(): string {
    let md = `# ${this.title}\n\n`;
    
    // User Story section
    if (this.userStory) {
      md += `${this.userStory}\n\n`;
    }

    // Steps
    this.steps.forEach((step, index) => {
      md += `### ${index + 1}. ${step.title}\n\n`;
      md += `![${step.title}](screenshots/${step.screenshotFile})\n\n`;
      
      if (step.verifications.length > 0) {
        md += `**Programmatic Verification:**\n`;
        step.verifications.forEach((v) => {
          md += `- [ ] ${v.description}\n`;
        });
        md += `\n`;
      }
    });

    return md;
  }

  writeReadme() {
    const content = this.generateMarkdown();
    const filePath = path.join(this.outputDir, "README.md");
    fs.writeFileSync(filePath, content);
    console.log(`\n📝 Generated README at: ${filePath}`);
  }
}
