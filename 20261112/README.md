This directory contains the results of my ham-fisted exploration of the iOS 27 issue. (See https://moodeaudio.org/forum/showthread.php?tid=9041&pid=75497#pid75497 and the related https://github.com/moode-player/moode/issues/844)

In this exercise, I probed the moOde codebase using opencode connected with DeepSeek V4.1 Flash Free and followed its suggestions to test various hypotheses. The exercise is best described as a drunkard's walk with these tools resulting in thousands of lines of reasoning and numerous explorations of alternatives. You're seeing only the last mile of the journey.

This directory contains a truncated version of the final opencode session transcript which I've named webkit-diag.md (I deleted the first 3984 lines of the current transcript, which itself follows on the heels of previous ones) and the modified www/js/links.js file it suggested.

**The result:** Replacing the version of www/js/links.js in the moOde repo with this modified version and using gulp to rebuild and deploy the result, I now have a moOde 10.3.7 player whose webUI apparently behaves correctly in browsers on my iPad (iPadOS 27.2.1) and my iPhone (iOS 27.2.1) and continues to behave correctly in browsers on my Android phone and Linux host. Specifically, the Configure modal, among others, no longer appears to immediately close (actually, it was the page reloading) after opening when clicked.

Note that the transcript makes several references to the results of tests I performed. I have chosen not to report the details here.

DISCLAIMER: I am not and never have been a JavaScript jockey. Unaided, I could not possibly fight my way through the code which implements the moOde webUI. I cannot claim I know opencode/DeepSeek are correctly fixing the iOS 27 issue but I believe this exercise may help the real moOde developer(s) do so.
