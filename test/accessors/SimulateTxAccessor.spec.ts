import { expect } from "chai";
import hre, { deployments, waffle } from "hardhat";
import "@nomiclabs/hardhat-ethers";
import { deployContract, getSimulateTxAccessor, getSafeWithOwners, getCompatFallbackHandler } from "../utils/setup";
import { buildContractCall } from "../utils/execution";
import { parseEther } from "ethers/lib/utils";

describe("SimulateTxAccessor", async () => {

    const [user1, user2] = waffle.provider.getWallets();

    const setupTests = deployments.createFixture(async ({ deployments }) => {
        await deployments.fixture();
        const accessor = await getSimulateTxAccessor()
        const source = `
        contract Test {
            function sendAndReturnBalance(address payable target, uint256 amount) public returns (uint256) {
                (bool success,) = target.call{ value: amount }("");
                require(success, "Transfer failed");
                return target.balance;
            }
        }`
        const interactor = await deployContract(user1, source);
        const handler = await getCompatFallbackHandler()
        const safe = await getSafeWithOwners([user1.address], 1, handler.address)
        const simulator = handler.attach(safe.address)
        return {
            safe,
            accessor,
            interactor,
            simulator
        }
    })

    describe("estimate", async () => {

        it('should enforce delegatecall', async () => {
            const { accessor } = await setupTests()
            const source = `
            contract Test {
                function killme() public {
                    selfdestruct(payable(msg.sender));
                }
            }`
            const killLib = await deployContract(user1, source);
            const tx = buildContractCall(killLib, "killme", [], 0)

            let code = await hre.ethers.provider.getCode(accessor.address)
            await expect(
                accessor.simulate(tx.to, tx.value, tx.data, tx.operation)
            ).to.be.revertedWith("SimulateTxAccessor should only be called via delegatecall")

            expect(await hre.ethers.provider.getCode(accessor.address)).to.be.eq(code)
        })

        it('simulate call', async () => {
            const { safe, accessor, simulator } = await setupTests()
            const tx = buildContractCall(safe, "getOwners", [], 0)
            const simulationData = accessor.interface.encodeFunctionData("simulate", [tx.to, tx.value, tx.data, tx.operation])
            const acccessibleData = await simulator.callStatic.simulateDelegatecall(accessor.address, simulationData) 
            const simulation = accessor.interface.decodeFunctionResult("simulate", acccessibleData)
            expect(
                safe.interface.decodeFunctionResult("getOwners", simulation.returnData)[0]
            ).to.be.deep.eq([user1.address])
            expect(
                simulation.success
            ).to.be.true
            expect(
                simulation.estimate.toNumber()
            ).to.be.lte(10000)
        })

        it('simulate delegatecall', async () => {
            const { safe, accessor, interactor, simulator } = await setupTests()
            await user1.sendTransaction({to: safe.address, value: parseEther("1")})
            const userBalance = await hre.ethers.provider.getBalance(user2.address)
            const tx = buildContractCall(interactor, "sendAndReturnBalance", [user2.address, parseEther("1")], 0, true)
            const simulationData = accessor.interface.encodeFunctionData("simulate", [tx.to, tx.value, tx.data, tx.operation])
            const acccessibleData = await simulator.callStatic.simulateDelegatecall(accessor.address, simulationData) 
            const simulation = accessor.interface.decodeFunctionResult("simulate", acccessibleData)
            expect(
                interactor.interface.decodeFunctionResult("sendAndReturnBalance", simulation.returnData)[0]
            ).to.be.deep.eq(userBalance.add(parseEther("1")))
            expect(
                simulation.success
            ).to.be.true
            expect(
                simulation.estimate.toNumber()
            ).to.be.lte(15000)
        })

        it('simulate revert', async () => {
            const { safe, accessor, interactor, simulator } = await setupTests()
            const tx = buildContractCall(interactor, "sendAndReturnBalance", [user2.address, parseEther("1")], 0, true)
            const simulationData = accessor.interface.encodeFunctionData("simulate", [tx.to, tx.value, tx.data, tx.operation])
            const acccessibleData = await simulator.callStatic.simulateDelegatecall(accessor.address, simulationData) 
            const simulation = accessor.interface.decodeFunctionResult("simulate", acccessibleData)
            expect(simulation.returnData).to.be.deep.eq("0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000f5472616e73666572206661696c65640000000000000000000000000000000000")
            expect(
                simulation.success
            ).to.be.false
            expect(
                simulation.estimate.toNumber()
            ).to.be.lte(20000)
        })
    })
})