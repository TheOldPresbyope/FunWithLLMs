# FunWithLLMs

I wanted to see what could be done with the free, open-source [opencode](https://opencode.ai) AI coding agent. It routinely offers 
the free use of certain LLMs, although the list of the free LLMs changes from time to time. I've installed
version 2 of opencode (CLI) on an underused Linux host.

## First exercise

For my first exercise, I've been using this agent with various LLMs to review the moOde Audio Player codebase
cloned locally from https://github.com/moode-player/moode.git. To keep things clean, I create copies of the 
cloned repo, one for each of the LLMs used (such as moode.deepseek). I have not created any of the usual guidance files
such as AGENTS.md or CLAUDE.md. I simply change to the root directory of the chosen copy, invoke opencode, and select the
appropriate LLM from the list offered by the /models command.

## LLMs

The LLMs used in this first exercise were Space Bunny, DeepSeek V4.1 Flash, GLM-5.3-Flash, Big Pickle. DeepSeek and
GLM are well credentialed; Space Bunny and Big Pickle are anonymous models available for limited amounts of time.
## opencode Prompt

The sole, naive prompt for each review in this first exercise was the following

"You are a systems developer in the root of the git repository for the codebase of the moOde audio player. The codebase consists mainly of php, python, bash, and javascript modules. The system architecture is described in the companion document ../docs/moode_application.md. Review the codebase for errors and prepare a report of the errors and of a remediation plan and save it in markdown format in the current directory. Do not modify any existing code."

No attempt was made to improve on this crude prompt, although it is obvious from the running output that improvements can be made.
A well-worded AGENTS.md would make prompting even simpler.

## Results

I'm putting the resulting reports in dated subdirectories. They are unmodified except for their filenames, which I've
edited to indicate the LLM involved.
